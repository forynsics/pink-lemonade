import Database from 'better-sqlite3'
import { join, basename, resolve } from 'path'
import { tmpdir } from 'os'
import {
  statSync,
  unlinkSync,
  readdirSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  openSync,
  readSync,
  writeSync,
  closeSync,
  realpathSync
} from 'fs'
import { binaryContentReason, isInsideDir, looksBinary, planSourceNaming, resolveInsideRoot, walkEvidence, type WalkResult } from './evidence'
import { mergeEntities, type DerivedEntity, type EntityOut } from './entityDerive'
import { entityId, isEntityActor, isEntityKind, isEntityStatus, type EntityActor, type EntityKind, type EntityStatus } from '../../shared/entities'
import { parseCsvStream } from './parser'
import { headerRowIndex, sanitizeHeaders, type ColumnMap } from './sanitize'
import { detectColumnNumeric, detectColumnTime, isEventTime, isPlausibleEpoch, type TimeKind } from './coltypes'
import {
  buildCreateTable,
  buildInsertSql,
  buildQueryRowsSql,
  buildCountSql,
  buildExportSql,
  csvRow,
  buildFilterInsertChunkSql,
  buildFiltPageSql,
  buildTagApplyByFilterSql,
  buildTagClearByFilterSql,
  buildAiMarkApplyByFilterSql,
  buildTagCountsSql,
  buildSweepScanSql,
  FILT_TABLE,
  buildDistinctChunkSql,
  DISTINCT_CAP,
  buildLongestSql,
  buildColumnValuesSql,
  buildStatsSql,
  buildTimeRangeSql,
  buildAggregateSql,
  buildAggregateCountSql,
  maxRowsPerInsert,
  type Filter,
  type QueryOpts,
  type Sort,
  type TimeBucket
} from './sql'
import { compileIntel, matchText, type IntelEntry } from './sweep'

// Loads the native better-sqlite3 binding for the CSV/workspace engine (enrich/cache.ts is the
// other better-sqlite3 user — both run only in the DB worker). Storage is PERSISTENT: a session
// db per import at <userData>/sessions/<tab>.db, and one <workspaceDir>/<id>.workspace db per
// workspace. Nothing is deleted on close (only explicit delete, or the startup sweep of legacy
// temp files). The renderer never touches this — it reaches the data through the csv:* IPC,
// which calls these functions and returns small result sets only.

export interface CsvTableMeta {
  tabId: string
  dbPath: string
  sourceName: string
  columns: ColumnMap[]
  rowCount: number
}

export interface CsvColumnStats {
  count: number
  nullCount: number
  distinct: number
}

export interface IngestArgs {
  tabId: string
  filePath: string
  sourceName: string
  onProgress?: (p: { bytes: number; rows: number; total: number }) => void
  signal?: AbortSignal
}

interface Entry {
  db: Database.Database
  meta: CsvTableMeta
  // The materialized filter index currently in the tab's filt table (Scale #1b): which predicate
  // it holds, how many rows so far, and whether the build finished.
  filt?: { token: string; count: number; complete: boolean }
  // Keys of column indexes already built on demand for sorting (Scale #3), e.g. "c3:n".
  indexes: Set<string>
  // The data table this entry queries ('data' legacy single-table, or 'data_<id>' for a workspace
  // source) and its materialized-filter table — so one connection can serve many source tables.
  table: string
  filtTable: string
  // Whether this entry owns its db connection (legacy single-file) or shares the workspace's
  // connection (a workspace source) — the latter is closed by closeWorkspace, not closeTab.
  ownsDb: boolean
}

interface Workspace {
  db: Database.Database
  dbPath: string
  name: string
  nextSourceId: number
}
const workspaces = new Map<string, Workspace>() // wsId -> open workspace

export interface SourceInfo {
  sourceId: number
  name: string
  columns: ColumnMap[]
  rowCount: number
  /** Absolute path the file was imported from — lets the UI detect re-imports of the same file. */
  originalPath: string
  /** Analyst-assigned grouping label (the host/system/origin the evidence belongs to, e.g. "HOST-A",
   *  "PaloAlto-Perimeter"); free text, no baked-in semantics. null = ungrouped. The Timeline's Host. */
  group: string | null
}
export interface WorkspaceInfo {
  wsId: string
  dbPath: string
  name: string
  sources: SourceInfo[]
  /** Which intel DB this workspace uses: 'global' (the app-wide Global Intel) or 'workspace'
   *  (its own sibling .intel.db). Persisted in ws_meta so it travels with the case file. */
  intelMode: 'global' | 'workspace'
}

const TEMP_PREFIX = 'pl_csv_' // legacy temp-db prefix (older builds) — still swept at startup
const tables = new Map<string, Entry>()

// db.ts runs in a worker thread (no Electron `app`); the userData dir is injected at worker init.
let USER_DATA = ''
export function initPaths(userDataDir: string): void {
  USER_DATA = userDataDir
}
function userDataDir(): string {
  if (!USER_DATA) throw new Error('db paths not initialized (initPaths must run first)')
  return USER_DATA
}

/** Persistent per-import database directory: <userData>/sessions. Survives restarts (Slice A). */
function sessionsDir(): string {
  const dir = join(userDataDir(), 'sessions')
  mkdirSync(dir, { recursive: true })
  return dir
}

function sessionDbPath(tabId: string): string {
  return join(sessionsDir(), `${safe(tabId)}.db`)
}

function safe(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '')
}

function applyImportPragmas(db: Database.Database): void {
  db.pragma('page_size = 65536')
  db.pragma('journal_mode = OFF')
  db.pragma('synchronous = OFF')
  db.pragma('temp_store = MEMORY')
}

function applyQueryPragmas(db: Database.Database): void {
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('cache_size = -262144') // 256 MB
  db.pragma('mmap_size = 536870912') // 512 MB
}

/** Stream a CSV from disk into `table` of an (open) db. Returns the detected columns + row count.
 *  Shared by the legacy single-file ingest and workspace addSource. */
async function ingestInto(
  db: Database.Database,
  table: string,
  filePath: string,
  onProgress: ((p: { bytes: number; rows: number; total: number }) => void) | undefined,
  signal: AbortSignal | undefined
): Promise<{ columns: ColumnMap[]; rowCount: number }> {
  let columns: ColumnMap[] = []
  let numCols = 0
  let multiN = 0
  let insertMulti: Database.Statement | null = null
  let insertOne: Database.Statement | null = null
  let flat: unknown[] = []
  let rowCount = 0
  const total = statSizeSafe(filePath)

  // Sample the first rows per column to detect time columns (see coltypes.detectColumnTime).
  const SAMPLE_ROWS = 200
  const samples: string[][] = []
  let sampled = 0

  const insertBatch = db.transaction((rows: string[][]) => {
    let i = 0
    while (i + multiN <= rows.length) {
      for (let r = 0; r < multiN; r++) {
        const row = rows[i + r]
        const off = r * numCols
        for (let c = 0; c < numCols; c++) flat[off + c] = row[c] ?? ''
      }
      insertMulti!.run(flat)
      i += multiN
    }
    for (; i < rows.length; i++) insertOne!.run(rows[i])
  })

  const res = await parseCsvStream(
    filePath,
    {
      onHeader: ({ columns: cols }) => {
        columns = cols
        numCols = cols.length
        for (let c = 0; c < numCols; c++) samples.push([])
        db.exec(buildCreateTable(cols, table))
        multiN = maxRowsPerInsert(numCols)
        insertMulti = db.prepare(buildInsertSql(cols, multiN, table))
        insertOne = db.prepare(buildInsertSql(cols, 1, table))
        flat = new Array(multiN * numCols)
      },
      onRows: (batch) => {
        for (const row of batch) {
          if (row.length < numCols) while (row.length < numCols) row.push('')
          else if (row.length > numCols) row.length = numCols
        }
        if (sampled < SAMPLE_ROWS) {
          for (const row of batch) {
            if (sampled >= SAMPLE_ROWS) break
            for (let c = 0; c < numCols; c++) samples[c].push(row[c] ?? '')
            sampled++
          }
        }
        insertBatch(batch)
        rowCount += batch.length
      },
      onProgress: (bytes, rows) => onProgress?.({ bytes, rows, total })
    },
    { signal }
  )

  if (res.canceled) throw new CsvIngestCanceled()
  if (columns.length === 0) {
    // "No header row" reads as "this file is malformed, go look at it". Usually it just has nothing
    // in it — a KAPE module that found no data still writes its (empty) output file, and an empty
    // UTF-16 file is a lone 2-byte BOM. Say which, so nobody re-opens an empty artifact to check.
    // An artifact that exists but is EMPTY is itself a finding, so this is not a silent skip.
    const bytes = statSizeSafe(filePath)
    throw new Error(
      bytes <= 4
        ? `The file is empty (${bytes} bytes) — nothing to import. An artifact that exists but holds no rows can itself be a finding worth noting.`
        : 'No header row found in file — the first line is blank or unparseable, so no columns could be read.'
    )
  }

  // Tag detected time columns from the sampled rows.
  columns = columns.map((c, i) => {
    const kind = detectColumnTime(samples[i] ?? [], c.original)
    // Numeric is about SORT ORDER, and a time column already sorts by its own kind, so only
    // untyped columns need the check — that is where recency ranks and record numbers live.
    const numeric = kind ? false : detectColumnNumeric(samples[i] ?? [])
    return kind ? { ...c, time: kind } : numeric ? { ...c, numeric: true } : c
  })
  return { columns, rowCount }
}

/** Stream a CSV from disk into a fresh persistent SQLite db (userData/sessions) and register it. */
export async function ingestCsv(args: IngestArgs): Promise<CsvTableMeta> {
  const { tabId, filePath, sourceName } = args
  closeTab(tabId) // drop any prior connection reusing this id

  const dbPath = sessionDbPath(tabId)
  removeDbFiles(dbPath) // a fresh import starts from a clean file (the path is reused per tabId)
  const db = new Database(dbPath)
  applyImportPragmas(db)

  try {
    const { columns, rowCount } = await ingestInto(db, 'data', filePath, args.onProgress, args.signal)

    // Make the db self-describing (Slice A): so reopening the bare .db reconstructs the view
    // without the original CSV, and "Open Database…" can validate it's a pink-lemonade db.
    writeSelfDescribingTables(db, sourceName, columns, rowCount)

    applyQueryPragmas(db)
    const meta: CsvTableMeta = { tabId, dbPath, sourceName, columns, rowCount }
    tables.set(tabId, { db, meta, indexes: new Set(), table: 'data', filtTable: FILT_TABLE, ownsDb: true })
    return meta
  } catch (e) {
    try {
      db.close()
    } catch {
      /* ignore */
    }
    removeDbFiles(dbPath)
    throw e
  }
}

export class CsvIngestCanceled extends Error {
  constructor() {
    super('CSV ingest canceled')
    this.name = 'CsvIngestCanceled'
  }
}

// ---- Workspaces (capstone): one db file holds many sources as data_<id> tables ----

// ---- App settings (a tiny userData/settings.json) ----
function settingsPath(): string {
  return join(userDataDir(), 'settings.json')
}
function readSettings(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(settingsPath(), 'utf-8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

/** Where workspaces live + the Open-Workspace dialog defaults — user-configurable, defaults to userData. */
export function getWorkspaceDir(): string {
  const s = readSettings()
  const dir =
    typeof s.workspaceDir === 'string' && s.workspaceDir ? s.workspaceDir : join(userDataDir(), 'workspaces')
  mkdirSync(dir, { recursive: true })
  return dir
}
// ---- Evidence root: the ONLY tree the AI agent may read from ----
// The agent never handles absolute paths. It passes paths RELATIVE to this root, and every one is
// resolved and containment-checked before it touches the filesystem, so the agent cannot name — let
// alone read — a file outside it. Set by the ANALYST; the agent has no tool to change it (if it could,
// the containment would be theatre). Unset = imports refuse (fail closed, never a silent "anywhere").

/** The configured evidence root, or null when the analyst hasn't set one. */
export function getEvidenceRoot(): string | null {
  const s = readSettings()
  return typeof s.evidenceRoot === 'string' && s.evidenceRoot ? s.evidenceRoot : null
}

/**
 * The evidence root and the workspace folder must not overlap, in EITHER direction.
 *
 * The evidence root is meant to be strictly read-only. But workspaces are created inside the
 * workspace folder by `create_case` — a tool the AI AGENT can call — and creating one writes a
 * `.workspace` file plus its `-wal`/`-shm` siblings. So if the workspace folder ever sat inside the
 * evidence root, an ordinary agent action would be writing into the evidence tree. The reverse
 * nesting is just as bad: evidence sitting inside the workspace folder is exposed to workspace
 * deletion (`deleteWorkspace` unlinks by path). Rejecting the overlap at configuration time is the
 * only place this can be enforced once and for all.
 */
function assertNoOverlap(evidenceRoot: string | null, workspaceDir: string | null): void {
  if (!evidenceRoot || !workspaceDir) return
  if (isInsideDir(workspaceDir, evidenceRoot)) {
    throw new Error(
      'The workspace folder cannot be inside the evidence folder — cases are written to disk there, which would modify your evidence. Choose a workspace folder outside it.'
    )
  }
  if (isInsideDir(evidenceRoot, workspaceDir)) {
    throw new Error(
      'The evidence folder cannot be inside the workspace folder — deleting a workspace would reach your evidence. Choose an evidence folder outside it.'
    )
  }
}

/** The workspace dir as CONFIGURED (no mkdir side effect) — for validation before we commit to it. */
function configuredWorkspaceDir(): string {
  const s = readSettings()
  return typeof s.workspaceDir === 'string' && s.workspaceDir ? s.workspaceDir : join(userDataDir(), 'workspaces')
}

export function setEvidenceRoot(dir: string | null): string | null {
  const s = readSettings()
  if (dir) {
    assertNoOverlap(dir, configuredWorkspaceDir())
    s.evidenceRoot = dir
  } else delete s.evidenceRoot
  try {
    writeFileSync(settingsPath(), JSON.stringify(s, null, 2))
  } catch {
    /* ignore */
  }
  return getEvidenceRoot()
}

/**
 * Resolve an agent-supplied RELATIVE path against the evidence root and prove it stays inside.
 *
 * A naive `startsWith` check is not enough: it misses `..` traversal, symlinks/junctions pointing
 * outside, and (on Windows) case differences. So we resolve BOTH sides through realpath — which
 * collapses `..` and follows links to their true target — and then compare on a separator boundary,
 * case-insensitively on win32. Anything that escapes, or that we cannot realpath, is rejected.
 * Absolute paths are refused outright: the agent has no business naming one.
 */
export function resolveInsideEvidenceRoot(relPath: string): string {
  return resolveInsideRoot(getEvidenceRootOrThrow(), relPath)
}

/**
 * List evidence under the root (recursively), as paths relative to it.
 *
 * `subdir` narrows to one branch and is containment-checked like any other agent path, so listing
 * cannot be used to enumerate the filesystem outside the root.
 */
/**
 * Which path component names the host, computed over the WHOLE evidence tree.
 *
 * Import must group files exactly as list_evidence reported them, but it only sees the handful of
 * paths being imported — and a single-host batch does not branch, so inferring from that subset would
 * pick an artifact-category directory instead. Always derive the level from the full tree.
 */
export function evidenceGroupDepth(): number {
  const realRoot = realpathSync(getEvidenceRootOrThrow())
  return walkEvidence(realRoot, realRoot).groupDepth
}

export function listEvidence(subdir?: string): WalkResult {
  const realRoot = realpathSync(getEvidenceRootOrThrow())
  const start = subdir && String(subdir).trim() ? resolveInsideEvidenceRoot(subdir) : realRoot
  return walkEvidence(realRoot, start)
}

function getEvidenceRootOrThrow(): string {
  const root = getEvidenceRoot()
  if (!root) throw new Error('No evidence root is configured. The analyst must set one before evidence can be imported.')
  if (!existsSync(root)) throw new Error(`The configured evidence root does not exist: ${root}`)
  return root
}

/** A workspace on disk, for the agent's list_workspaces / use_workspace. */
export interface WorkspaceEntry {
  wsId: string
  name: string
  dbPath: string
  createdAt: number | null
  sourceCount: number
}

/**
 * Catalog the workspaces in the workspace dir by reading each one's ws_meta.
 *
 * Opened read-only through a SEPARATE short-lived connection, never the live `workspaces` map — this
 * must not disturb (or be disturbed by) a workspace the analyst currently has open. A file that fails
 * to open is skipped, not fatal: one corrupt db shouldn't hide every other case.
 */
export function listWorkspaces(): WorkspaceEntry[] {
  const dir = getWorkspaceDir()
  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.workspace'))
  } catch {
    return []
  }
  const out: WorkspaceEntry[] = []
  for (const f of files) {
    const dbPath = join(dir, f)
    let db: Database.Database | null = null
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true })
      const meta = new Map<string, string>()
      for (const r of db.prepare('SELECT key, value FROM ws_meta').all() as Array<{ key: string; value: string }>) {
        meta.set(r.key, r.value)
      }
      const n = db.prepare('SELECT COUNT(*) AS n FROM sources').get() as { n: number }
      const created = Number(meta.get('created_at'))
      out.push({
        wsId: f.slice(0, -'.workspace'.length),
        name: meta.get('name') || f,
        dbPath,
        createdAt: Number.isFinite(created) ? created : null,
        sourceCount: n?.n ?? 0
      })
    } catch {
      /* not a readable workspace — skip */
    } finally {
      try {
        db?.close()
      } catch {
        /* ignore */
      }
    }
  }
  out.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  return out
}

export function setWorkspaceDir(dir: string): string {
  const s = readSettings()
  assertNoOverlap(getEvidenceRoot(), dir)
  s.workspaceDir = dir
  try {
    writeFileSync(settingsPath(), JSON.stringify(s, null, 2))
  } catch {
    /* ignore */
  }
  return getWorkspaceDir()
}

// ---- Enrichment config (lives under the `enrich` key in the same settings.json) ----
// e.g. { maxmindCityPath: '…/GeoLite2-City.mmdb' } plus provider settings. API keys are stored
// encrypted via Electron safeStorage and decrypted only in main (never here / never in the worker):
// `maxmindKeyEnc` (MaxMind license) and `vtKeyEnc` (VirusTotal). VirusTotal also stores its
// auto-detected pace/quota here (non-secret): `vtRequestsPerMinute`, `vtDailyQuota`.
export function getEnrichConfig(): Record<string, unknown> {
  const s = readSettings()
  return s.enrich && typeof s.enrich === 'object' ? (s.enrich as Record<string, unknown>) : {}
}
export function setEnrichConfig(patch: Record<string, unknown>): Record<string, unknown> {
  const s = readSettings()
  s.enrich = { ...getEnrichConfig(), ...patch }
  try {
    writeFileSync(settingsPath(), JSON.stringify(s, null, 2))
  } catch {
    /* ignore */
  }
  return getEnrichConfig()
}

// ---- AI config (lives under the `ai` key in the same settings.json) ----
// Non-secret only (e.g. the localhost MCP token/port). The agent is the analyst's OWN, run through the
// user's own installed Claude Code (their Claude subscription) — there is NO API key stored here, in
// the worker, or anywhere; auth lives in the user's Claude Code login.
export function getAiConfig(): Record<string, unknown> {
  const s = readSettings()
  return s.ai && typeof s.ai === 'object' ? (s.ai as Record<string, unknown>) : {}
}
export function setAiConfig(patch: Record<string, unknown>): Record<string, unknown> {
  const s = readSettings()
  s.ai = { ...getAiConfig(), ...patch }
  try {
    writeFileSync(settingsPath(), JSON.stringify(s, null, 2))
  } catch {
    /* ignore */
  }
  return getAiConfig()
}

function workspaceDbPath(wsId: string): string {
  return join(getWorkspaceDir(), `${safe(wsId)}.workspace`)
}

/** The on-disk path of an OPEN workspace — the agent-SQL runner opens this read-only on its own
 *  thread. Returns null when the workspace isn't open, so a caller can't be handed a path to a
 *  workspace this process isn't actually managing. */
export function openWorkspacePath(wsId: string): string | null {
  return workspaces.get(wsId)?.dbPath ?? null
}

/** Composite key a workspace source is registered/queried under (used as `tabId` by the query IPC). */
export function sourceKey(wsId: string, sourceId: number): string {
  return `${wsId}:${sourceId}`
}

/** Register a source as a query entry sharing the workspace's connection (it doesn't own it). */
function registerSource(
  wsId: string,
  sourceId: number,
  sourceName: string,
  columns: ColumnMap[],
  rowCount: number,
  db: Database.Database,
  dbPath: string
): void {
  const meta: CsvTableMeta = { tabId: sourceKey(wsId, sourceId), dbPath, sourceName, columns, rowCount }
  tables.set(sourceKey(wsId, sourceId), {
    db,
    meta,
    indexes: new Set(),
    table: `data_${sourceId}`,
    filtTable: `_pl_filt_${sourceId}`,
    ownsDb: false
  })
}

/** Create a fresh workspace db (catalog tables only) and register it open. */
export function createWorkspace(wsId: string, name: string): WorkspaceInfo {
  closeWorkspace(wsId)
  const dbPath = workspaceDbPath(wsId)
  removeDbFiles(dbPath)
  const db = new Database(dbPath)
  applyImportPragmas(db) // sets page_size before any table is created
  db.exec('CREATE TABLE ws_meta (key TEXT PRIMARY KEY, value TEXT)')
  const setMeta = db.prepare('INSERT OR REPLACE INTO ws_meta (key, value) VALUES (?, ?)')
  setMeta.run('name', name)
  setMeta.run('version', String(SCHEMA_VERSION))
  setMeta.run('created_at', String(Date.now()))
  setMeta.run('intelMode', 'global') // default: use the app-wide Global Intel
  db.exec(
    'CREATE TABLE sources (id INTEGER PRIMARY KEY, name TEXT, original_path TEXT, row_count INTEGER, num_cols INTEGER, added_at INTEGER, group_label TEXT)'
  )
  db.exec(
    'CREATE TABLE source_columns (source_id INTEGER, idx INTEGER, name TEXT, original TEXT, time TEXT, numeric INTEGER, PRIMARY KEY(source_id, idx))'
  )
  db.exec(TAGS_DDL)
  db.exec(INTEL_HITS_DDL)
  db.exec(AI_MARKS_DDL)
  db.exec(EVENTS_DDL)
  db.exec(EVENT_EVIDENCE_DDL)
  db.exec(EVENT_ENTITIES_DDL)
  db.exec(IOCS_DDL)
  db.exec(AI_COVERAGE_DDL)
  applyQueryPragmas(db)
  workspaces.set(wsId, { db, dbPath, name, nextSourceId: 0 })
  return { wsId, dbPath, name, sources: [], intelMode: 'global' }
}

/**
 * Make a source label unique WITHIN a workspace, so every source is addressable by name.
 *
 * Source names were never unique-constrained, and two hosts in one case routinely yield the same
 * filename (KAPE gives every machine an `Amcache.csv`). A duplicate isn't just untidy: `resolveSource`
 * rejects an ambiguous bare name outright, so a colliding import would leave that source reachable
 * only by numeric id. We qualify with the group first — that's the information the analyst actually
 * wants to see ("HOST-A — Amcache.csv") — and only fall back to a counter when there's no group or
 * the qualified name collides too, which guarantees this terminates.
 */
function planNaming(db: Database.Database, desired: string, group: string | null): string {
  ensureSourceGroupColumn(db)
  const rows = db.prepare('SELECT id, name, group_label FROM sources').all() as Array<{ id: number; name: string; group_label: string | null }>
  return planSourceNaming(desired, group, rows.map((r) => ({ id: r.id, name: r.name, group: r.group_label }))).name
}

/**
 * Reserve the next `data_<id>` table, and make sure that name is actually free.
 *
 * The id is advanced BEFORE the ingest runs, so a failed import can never hand the same id to the
 * next one. It used to: the failure path dropped the partial table but left `nextSourceId` alone, so
 * the following import tried to CREATE the same table and died with "table data_N already exists" —
 * one bad file poisoned every import after it. Worse, when the failure was severe enough to take the
 * connection down, the cleanup DROP silently failed too and the stale table really was still there.
 * So we also drop defensively here, which additionally clears anything a previous crash left behind.
 */
function claimSourceId(w: { db: Database.Database; nextSourceId: number }): number {
  const sourceId = w.nextSourceId
  w.nextSourceId = sourceId + 1
  dropTableQuietly(w, sourceId)
  return sourceId
}

/** Refuse a file whose bytes are binary, however its extension is spelled. Reads only the head. */
function assertNotBinary(filePath: string, displayName: string): void {
  let fd: number | null = null
  try {
    fd = openSync(filePath, 'r')
    const head = Buffer.alloc(8192)
    const read = readSync(fd, head, 0, head.length, 0)
    if (looksBinary(head.subarray(0, read))) throw new Error(binaryContentReason(displayName))
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* ignore */
      }
    }
  }
}

/** Best-effort DROP of a source's data table — used for cleanup paths that must not mask the real error. */
function dropTableQuietly(w: { db: Database.Database }, sourceId: number): void {
  try {
    w.db.exec(`DROP TABLE IF EXISTS data_${sourceId}`)
  } catch {
    /* the connection may already be gone; the reserved id means it can't collide anyway */
  }
}

/** Ingest a CSV as a new source (data_<id>) in an open workspace; updates the catalog. */
export async function addSource(args: {
  wsId: string
  filePath: string
  sourceName: string
  /** Host/system the artifact came from. Set at ingest by the agent's evidence import (derived from
   *  the evidence-root subdirectory); the UI leaves it null and assigns groups afterwards. */
  group?: string | null
  onProgress?: (p: { bytes: number; rows: number; total: number }) => void
  signal?: AbortSignal
}): Promise<SourceInfo> {
  const w = workspaces.get(args.wsId)
  if (!w) throw new Error(`Workspace not open: ${args.wsId}`)
  // The extension is a claim; check the content before creating anything. A renamed binary would
  // otherwise land as a source with garbage columns and no rows, which reads as real evidence.
  assertNotBinary(args.filePath, args.sourceName)
  const sourceId = claimSourceId(w)
  w.db.pragma('journal_mode = OFF')
  w.db.pragma('synchronous = OFF')
  let columns: ColumnMap[]
  let rowCount: number
  try {
    ;({ columns, rowCount } = await ingestInto(w.db, `data_${sourceId}`, args.filePath, args.onProgress, args.signal))
  } catch (e) {
    dropTableQuietly(w, sourceId)
    w.db.pragma('journal_mode = WAL')
    w.db.pragma('synchronous = NORMAL')
    throw e
  }
  w.db.pragma('journal_mode = WAL')
  w.db.pragma('synchronous = NORMAL')
  const setCol = w.db.prepare('INSERT INTO source_columns (source_id, idx, name, original, time, numeric) VALUES (?, ?, ?, ?, ?, ?)')
  w.db.transaction(() => columns.forEach((c, i) => setCol.run(sourceId, i, c.name, c.original, c.time ?? null, c.numeric ? 1 : 0)))()
  const group = typeof args.group === 'string' && args.group.trim() ? args.group.trim().slice(0, 120) : null
  // Uniquify against what's already in this workspace, so the source stays addressable by name.
  const name = planNaming(w.db, args.sourceName, group)
  ensureSourceGroupColumn(w.db)
  w.db
    .prepare('INSERT INTO sources (id, name, original_path, row_count, num_cols, added_at, group_label) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(sourceId, name, args.filePath, rowCount, columns.length, Date.now(), group)
  registerSource(args.wsId, sourceId, name, columns, rowCount, w.db, w.dbPath)
  return { sourceId, name, columns, rowCount, originalPath: args.filePath, group }
}

// ---- Excel (.xlsx/.xlsm) ingest ----
// Same sink as CSV (sanitizeHeaders → create table → bulk insert → time-detect), but rows come from
// a worksheet held in memory instead of a streamed file. One source per non-empty worksheet.

interface XlsxSheet {
  name: string
  header: string[]
  rows: string[][]
}

/** Stringify one ExcelJS cell value (dates → ISO; rich text / hyperlink / formula → their text). */
function xlsxCellToString(v: unknown): string {
  if (v == null) return ''
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    if (Array.isArray(o.richText)) return (o.richText as Array<{ text?: string }>).map((t) => t.text ?? '').join('')
    if ('text' in o) return String(o.text ?? '')
    if ('result' in o) return o.result == null ? '' : String(o.result)
    if ('hyperlink' in o) return String(o.hyperlink ?? '')
    if ('error' in o) return String(o.error ?? '')
    return ''
  }
  return String(v)
}

/** Read a workbook into per-sheet header + rows (lazy-loads ExcelJS so non-Excel ingests don't pay). */
async function readXlsxSheets(filePath: string): Promise<XlsxSheet[]> {
  const mod = (await import('exceljs')) as unknown as { default?: unknown }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ExcelJS: any = mod.default ?? mod
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(filePath)
  const out: XlsxSheet[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wb.eachSheet((ws: any) => {
    const rows: string[][] = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ws.eachRow({ includeEmpty: false }, (row: any) => {
      const vals = (row.values as unknown[]) ?? []
      const cells: string[] = []
      for (let i = 1; i < vals.length; i++) cells.push(xlsxCellToString(vals[i])) // row.values is 1-indexed
      rows.push(cells)
    })
    if (rows.length === 0) return
    // Pad the header to the widest row so a column with a blank header isn't dropped.
    let width = 0
    for (const r of rows) width = Math.max(width, r.length)
    const headerRow = headerRowIndex(rows)
    const header = rows[headerRow].slice()
    while (header.length < width) header.push('')
    out.push({ name: ws.name, header, rows: rows.slice(headerRow + 1) })
  })
  return out
}

/** In-memory variant of ingestInto: load a worksheet's rows into `table`. Mirrors the CSV sink
 *  (sanitize header → create table → batched insert → sample for time detection). */
function ingestRowsInto(
  db: Database.Database,
  table: string,
  header: string[],
  rows: string[][],
  onProgress: ((p: { bytes: number; rows: number; total: number }) => void) | undefined,
  signal: AbortSignal | undefined
): { columns: ColumnMap[]; rowCount: number } {
  let columns = sanitizeHeaders(header)
  const numCols = columns.length
  if (numCols === 0) throw new Error('Worksheet has no header row')
  db.exec(buildCreateTable(columns, table))
  const multiN = maxRowsPerInsert(numCols)
  const insertMulti = db.prepare(buildInsertSql(columns, multiN, table))
  const insertOne = db.prepare(buildInsertSql(columns, 1, table))
  const flat: unknown[] = new Array(multiN * numCols)
  const insertBatch = db.transaction((batch: string[][]) => {
    let i = 0
    while (i + multiN <= batch.length) {
      for (let r = 0; r < multiN; r++) {
        const row = batch[i + r]
        const off = r * numCols
        for (let c = 0; c < numCols; c++) flat[off + c] = row[c] ?? ''
      }
      insertMulti.run(flat)
      i += multiN
    }
    for (; i < batch.length; i++) insertOne.run(batch[i])
  })

  for (const row of rows) {
    if (row.length < numCols) while (row.length < numCols) row.push('')
    else if (row.length > numCols) row.length = numCols
  }
  const SAMPLE_ROWS = 200
  const samples: string[][] = columns.map(() => [])
  const sCount = Math.min(SAMPLE_ROWS, rows.length)
  for (let i = 0; i < sCount; i++) for (let c = 0; c < numCols; c++) samples[c].push(rows[i][c] ?? '')

  const CHUNK = 5000
  let rowCount = 0
  for (let i = 0; i < rows.length; i += CHUNK) {
    if (signal?.aborted) throw new CsvIngestCanceled()
    const batch = rows.slice(i, i + CHUNK)
    insertBatch(batch)
    rowCount += batch.length
    onProgress?.({ bytes: 0, rows: rowCount, total: rows.length })
  }
  columns = columns.map((c, i) => {
    const kind = detectColumnTime(samples[i] ?? [], c.original)
    // Numeric is about SORT ORDER, and a time column already sorts by its own kind, so only
    // untyped columns need the check — that is where recency ranks and record numbers live.
    const numeric = kind ? false : detectColumnNumeric(samples[i] ?? [])
    return kind ? { ...c, time: kind } : numeric ? { ...c, numeric: true } : c
  })
  return { columns, rowCount }
}

/** Ingest each non-empty worksheet of an Excel workbook as its own source in an open workspace.
 *  Multi-sheet workbooks name sources "<file> — <sheet>"; a single-sheet workbook keeps the file name. */
export async function addXlsxSources(args: {
  wsId: string
  filePath: string
  sourceName: string
  /** Host/system for every sheet in the workbook (set by the agent's evidence import). */
  group?: string | null
  onProgress?: (p: { bytes: number; rows: number; total: number }) => void
  signal?: AbortSignal
}): Promise<SourceInfo[]> {
  const w = workspaces.get(args.wsId)
  if (!w) throw new Error(`Workspace not open: ${args.wsId}`)
  const sheets = (await readXlsxSheets(args.filePath)).filter((s) => s.header.length > 0 && s.rows.length > 0)
  if (sheets.length === 0) throw new Error('No non-empty worksheets found in the workbook.')
  const multi = sheets.length > 1
  const out: SourceInfo[] = []
  for (const sheet of sheets) {
    if (args.signal?.aborted) throw new CsvIngestCanceled()
    const sourceId = claimSourceId(w)
    w.db.pragma('journal_mode = OFF')
    w.db.pragma('synchronous = OFF')
    let columns: ColumnMap[]
    let rowCount: number
    try {
      ;({ columns, rowCount } = ingestRowsInto(w.db, `data_${sourceId}`, sheet.header, sheet.rows, args.onProgress, args.signal))
    } catch (e) {
      dropTableQuietly(w, sourceId)
      w.db.pragma('journal_mode = WAL')
      w.db.pragma('synchronous = NORMAL')
      throw e
    }
    w.db.pragma('journal_mode = WAL')
    w.db.pragma('synchronous = NORMAL')
    const setCol = w.db.prepare('INSERT INTO source_columns (source_id, idx, name, original, time, numeric) VALUES (?, ?, ?, ?, ?, ?)')
    w.db.transaction(() => columns.forEach((c, i) => setCol.run(sourceId, i, c.name, c.original, c.time ?? null, c.numeric ? 1 : 0)))()
    const group = typeof args.group === 'string' && args.group.trim() ? args.group.trim().slice(0, 120) : null
    // Same uniqueness rule as the CSV path: two hosts' workbooks share sheet names constantly.
    const srcName = planNaming(w.db, multi ? `${args.sourceName} — ${sheet.name}` : args.sourceName, group)
    ensureSourceGroupColumn(w.db)
    w.db
      .prepare('INSERT INTO sources (id, name, original_path, row_count, num_cols, added_at, group_label) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(sourceId, srcName, args.filePath, rowCount, columns.length, Date.now(), group)
    registerSource(args.wsId, sourceId, srcName, columns, rowCount, w.db, w.dbPath)
    out.push({ sourceId, name: srcName, columns, rowCount, originalPath: args.filePath, group })
  }
  return out
}

/** original_path sentinel marking the generated Timeline source, so a rebuild can find + replace it. */
export const TIMELINE_MARKER = '<timeline>'

/** (Re)build the curated Timeline as a real source table the grid can open — so the full grid engine
 *  (filter/sort/tag/export) applies to it. The rows are composed in the renderer from recorded events
 *  and passed in (header + cells). Replaces any prior generated Timeline source, then ingests the rows
 *  (which also auto-detects the Time column). Returns the new source. */
export function buildTimelineSource(wsId: string, header: string[], rows: string[][]): SourceInfo {
  const w = workspaces.get(wsId)
  if (!w) throw new Error(`Workspace not open: ${wsId}`)
  ensureSourceGroupColumn(w.db)
  // Drop any previous generated Timeline source so a rebuild replaces (not duplicates) it.
  const prior = w.db.prepare('SELECT id FROM sources WHERE original_path = ?').all(TIMELINE_MARKER) as Array<{ id: number }>
  for (const p of prior) removeSource(wsId, p.id)

  const sourceId = w.nextSourceId
  w.db.pragma('journal_mode = OFF')
  w.db.pragma('synchronous = OFF')
  let columns: ColumnMap[]
  let rowCount: number
  try {
    ;({ columns, rowCount } = ingestRowsInto(w.db, `data_${sourceId}`, header, rows, undefined, undefined))
  } catch (e) {
    try {
      w.db.exec(`DROP TABLE IF EXISTS data_${sourceId}`)
    } catch {
      /* ignore */
    }
    w.db.pragma('journal_mode = WAL')
    w.db.pragma('synchronous = NORMAL')
    throw e
  }
  w.db.pragma('journal_mode = WAL')
  w.db.pragma('synchronous = NORMAL')
  const setCol = w.db.prepare('INSERT INTO source_columns (source_id, idx, name, original, time, numeric) VALUES (?, ?, ?, ?, ?, ?)')
  w.db.transaction(() => columns.forEach((c, i) => setCol.run(sourceId, i, c.name, c.original, c.time ?? null, c.numeric ? 1 : 0)))()
  w.db
    .prepare('INSERT INTO sources (id, name, original_path, row_count, num_cols, added_at, group_label) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(sourceId, 'Timeline', TIMELINE_MARKER, rowCount, columns.length, Date.now(), null)
  w.nextSourceId = sourceId + 1
  registerSource(wsId, sourceId, 'Timeline', columns, rowCount, w.db, w.dbPath)
  return { sourceId, name: 'Timeline', columns, rowCount, originalPath: TIMELINE_MARKER, group: null }
}

/** Open an existing workspace db and register all its sources (no re-ingest). */
export function openWorkspace(wsId: string, dbPath: string): WorkspaceInfo {
  closeWorkspace(wsId)
  if (!existsSync(dbPath)) throw new Error('Workspace file not found')
  const db = new Database(dbPath)
  let metaRows: Array<{ key: string; value: string }>
  let srcRows: Array<{ id: number; name: string; row_count: number; original_path: string | null; group_label: string | null }>
  try {
    metaRows = db.prepare('SELECT key, value FROM ws_meta').all() as typeof metaRows
    ensureSourceGroupColumn(db) // …added after grouping shipped; must exist before the SELECT below
    srcRows = db.prepare('SELECT id, name, row_count, original_path, group_label FROM sources ORDER BY id').all() as typeof srcRows
  } catch {
    db.close()
    throw new Error('Not a pink-lemonade workspace')
  }
  db.exec(TAGS_DDL) // workspaces created before tagging shipped won't have this table yet
  ensureTagActorColumn(db) // …and those created before AI attribution won't have the actor column
  db.exec(INTEL_HITS_DDL) // …nor intel-sweep sightings
  db.exec(AI_MARKS_DDL) // …nor AI-accountability marks
  db.exec(EVENTS_DDL) // …nor events
  db.exec(EVENT_EVIDENCE_DDL)
  db.exec(EVENT_ENTITIES_DDL) // …nor the event-entity (user attribution) table
  db.exec(IOCS_DDL) // …nor the IOC catalog
  db.exec(AI_COVERAGE_DDL) // …nor the AI's triage-coverage record
  db.exec(AI_SQL_LOG_DDL) // …nor its SQL audit trail
  applyQueryPragmas(db)
  // `numeric` arrived after sorting shipped; a workspace made before it has no such column, so the
  // SELECT below (which reads it, OUTSIDE the try/catch above) would throw and make the whole
  // workspace unopenable. Add it first — its sibling ensure* guards run above for the same reason.
  ensureSourceColumnNumeric(db)
  const m = Object.fromEntries(metaRows.map((r) => [r.key, r.value]))
  const name = m.name ?? basename(dbPath)
  const colStmt = db.prepare('SELECT name, original, time, numeric FROM source_columns WHERE source_id = ? ORDER BY idx')
  const sources: SourceInfo[] = []
  let maxId = -1
  for (const s of srcRows) {
    const colRows = colStmt.all(s.id) as Array<{ name: string; original: string; time: string | null; numeric: number | null }>
    const columns: ColumnMap[] = colRows.map((c) =>
      c.time
        ? { name: c.name, original: c.original, time: c.time as TimeKind }
        : c.numeric
          ? { name: c.name, original: c.original, numeric: true }
          : { name: c.name, original: c.original }
    )
    registerSource(wsId, s.id, s.name, columns, s.row_count, db, dbPath)
    sources.push({ sourceId: s.id, name: s.name, columns, rowCount: s.row_count, originalPath: s.original_path ?? '', group: s.group_label ?? null })
    maxId = Math.max(maxId, s.id)
  }
  const ws = { db, dbPath, name, nextSourceId: maxId + 1 }
  workspaces.set(wsId, ws)
  // Heal records written before the path-qualified source names and the timestamp-plausibility fix,
  // so an existing case doesn't keep double-counting a file or anchoring an event at 1970/2079.
  try {
    backfillEvidence(ws)
  } catch {
    /* a repair must never block opening the workspace */
  }
  const intelMode = m.intelMode === 'workspace' ? 'workspace' : 'global'
  return { wsId, dbPath, name, sources, intelMode }
}

/** Set which intel a workspace uses ('global' | 'workspace'); persists to ws_meta. */
export function setWorkspaceIntelMode(wsId: string, mode: 'global' | 'workspace'): void {
  const w = workspaces.get(wsId)
  if (!w) return
  w.db.prepare('INSERT OR REPLACE INTO ws_meta (key, value) VALUES (?, ?)').run('intelMode', mode)
}

/** Rename a workspace — persists to ws_meta so it survives reopen. */
export function renameWorkspace(wsId: string, name: string): void {
  const w = workspaces.get(wsId)
  if (!w) return
  w.db.prepare('INSERT OR REPLACE INTO ws_meta (key, value) VALUES (?, ?)').run('name', name)
  w.name = name
}

/** Rename a source's display label (sources.name) — a pure label, decoupled from the data table. */
export function renameSource(wsId: string, sourceId: number, name: string): void {
  const w = workspaces.get(wsId)
  if (!w || !Number.isInteger(sourceId)) return
  w.db.prepare('UPDATE sources SET name = ? WHERE id = ?').run(name, sourceId)
  const e = tables.get(sourceKey(wsId, sourceId)) // keep the live viewer title in sync
  if (e) e.meta.sourceName = name
}

/** Set (or clear) a source's grouping label — the host/system/origin it belongs to (the Timeline's
 *  Host column). Free text; empty/whitespace clears it back to ungrouped (null). Persists to sources. */
export function setSourceGroup(wsId: string, sourceId: number, group: string | null): void {
  const w = workspaces.get(wsId)
  if (!w || !Number.isInteger(sourceId)) return
  ensureSourceGroupColumn(w.db)
  const val = typeof group === 'string' && group.trim() ? group.trim().slice(0, 120) : null
  w.db.prepare('UPDATE sources SET group_label = ? WHERE id = ?').run(val, sourceId)
}

export interface DerivedColumnSpec {
  /** JSON1 path to pull, e.g. `$.Operation`. Bound as a parameter to json_extract — never interpolated. */
  path: string
  /** Display header for the new column (defaults to the JSON key). */
  displayName: string
}

/**
 * Extract scalar JSON sub-fields of `jsonColName` into new first-class columns on the SAME source
 * (Option A — in place, no re-import). O365/Hayabusa logs cram their real content into one JSON blob;
 * this brings the "expand in Excel" step in-app. For each field: ALTER TABLE … ADD COLUMN cK,
 * backfill with json_extract (guarded by json_valid so malformed/empty cells become NULL instead of
 * aborting), catalog it in source_columns, time-detect it, and push it onto the live registration.
 * Adding a column preserves every rowid, so existing tags / AI-marks / intel sightings / event
 * evidence (all keyed by (source_id, rid)) stay valid. Returns the newly added ColumnMap[] so the
 * renderer can append them to the live source. (JSON1 — json_valid/json_extract — ships in
 * better-sqlite3's bundled SQLite.)
 */
export function addDerivedColumns(
  wsId: string,
  sourceId: number,
  jsonColName: string,
  fields: DerivedColumnSpec[]
): ColumnMap[] {
  const w = workspaces.get(wsId)
  if (!w || !Number.isInteger(sourceId)) throw new Error('Workspace/source not open')
  const e = tables.get(sourceKey(wsId, sourceId))
  if (!e) throw new Error(`Source not registered: ${sourceId}`)
  const table = `data_${sourceId}`

  // The JSON source column must be one of THIS source's columns (so its safe cN name is whitelisted).
  const jsonCol = e.meta.columns.find((c) => c.name === jsonColName)
  if (!jsonCol) throw new Error(`Unknown column: ${jsonColName}`)

  // Normalize the requested fields: paths are bound (safe) but must look like a JSON path;
  // displayName is trimmed + length-capped. Drop anything malformed.
  const specs = (Array.isArray(fields) ? fields : [])
    .map((f) => ({
      path: String(f?.path ?? '').trim(),
      displayName: String(f?.displayName ?? '').trim().slice(0, 120)
    }))
    .filter((f) => f.path.startsWith('$') && f.displayName)
  if (specs.length === 0) throw new Error('No valid fields to extract')

  const added: ColumnMap[] = []
  const setCol = w.db.prepare('INSERT INTO source_columns (source_id, idx, name, original, time, numeric) VALUES (?, ?, ?, ?, ?, ?)')

  w.db.transaction(() => {
    // source_columns idx is a dense 0..N-1 sequence (columns are never removed individually), so the
    // next safe id is simply the current count. e.meta.columns is left untouched until the txn commits.
    let idx = e.meta.columns.length
    for (const spec of specs) {
      const cK = `c${idx}` // dense next positional id — satisfies COL_RE
      // 1. Add the physical column (cK / table / jsonCol.name are all whitelisted cN/data_<id> names).
      w.db.exec(`ALTER TABLE ${table} ADD COLUMN ${cK} TEXT`)
      // 2. Backfill: pull the scalar from valid-JSON cells; malformed/empty cells stay NULL.
      w.db
        .prepare(`UPDATE ${table} SET ${cK} = CASE WHEN json_valid(${jsonCol.name}) THEN json_extract(${jsonCol.name}, ?) END`)
        .run(spec.path)
      // 3. Time-detect from a sample so an extracted timestamp enables time filters.
      const samples = (
        w.db.prepare(`SELECT ${cK} AS v FROM ${table} WHERE ${cK} IS NOT NULL AND ${cK} <> '' LIMIT 200`).all() as Array<{ v: string }>
      ).map((r) => r.v)
      const time = detectColumnTime(samples, spec.displayName) ?? undefined
      // 4. Catalog + collect for the live registration.
      setCol.run(sourceId, idx, cK, spec.displayName, time ?? null, 0)
      added.push(time ? { name: cK, original: spec.displayName, time } : { name: cK, original: spec.displayName })
      idx++
    }
    // num_cols is cosmetic (never read back) but keep it honest.
    w.db.prepare('UPDATE sources SET num_cols = ? WHERE id = ?').run(e.meta.columns.length + added.length, sourceId)
  })()

  // Mutate the live registration IN PLACE — queryRows/export/distinct/search all build from this.
  e.meta.columns.push(...added)
  e.filt = undefined // invalidate any cached filter index (rowids unchanged, but stay clean)
  return added
}

/** Remove a source (imported file) from a workspace: drop its table + catalog rows + tags. */
export function removeSource(wsId: string, sourceId: number): void {
  const w = workspaces.get(wsId)
  if (!w || !Number.isInteger(sourceId)) return
  w.db.exec(`DROP TABLE IF EXISTS data_${sourceId}`) // indexes drop with the table
  w.db.exec(`DROP TABLE IF EXISTS _pl_filt_${sourceId}`)
  w.db.prepare('DELETE FROM sources WHERE id = ?').run(sourceId)
  w.db.prepare('DELETE FROM source_columns WHERE source_id = ?').run(sourceId)
  w.db.prepare('DELETE FROM tags WHERE source_id = ?').run(sourceId)
  w.db.prepare('DELETE FROM ai_marks WHERE source_id = ?').run(sourceId)
  // Everything that references this source by id must be cleaned, or the review panels keep citing a
  // deleted file. Each table is guarded on its own: a workspace that predates a given feature simply
  // has no such table, and one missing table must not skip the others (the previous single try block
  // deleted a NONEXISTENT `finding_hits` first — the old constellation substrate, since removed — which
  // threw and skipped event_evidence entirely, orphaning every event's evidence).
  const del = (sql: string): void => {
    try {
      w.db.prepare(sql).run(sourceId)
    } catch {
      /* table absent in an older workspace — fine */
    }
  }
  // evidence_times is keyed by evidence_id, so drop its rows via the evidence about to go.
  del('DELETE FROM evidence_times WHERE evidence_id IN (SELECT id FROM event_evidence WHERE source_id = ?)')
  del('DELETE FROM event_evidence WHERE source_id = ?')
  del('DELETE FROM lead_grounding WHERE source_id = ?')
  del('DELETE FROM entity_grounding WHERE source_id = ?')
  del('DELETE FROM intel_hits WHERE source_id = ?')
  tables.delete(sourceKey(wsId, sourceId))
}

// ---- Row tags (Phase 2 capstone) ----
// One row of `tags` per tagged row, keyed by (source_id, positional rowid). Row identity is the
// rowid of data_<source_id> — stable because the workspace db is never rebuilt (the rows keep
// their original insert order forever). One tag per row: setting replaces, clearing deletes.
const TAGS_DDL =
  'CREATE TABLE IF NOT EXISTS tags (source_id INTEGER NOT NULL, rid INTEGER NOT NULL, tag TEXT NOT NULL, note TEXT, updated_at INTEGER, actor TEXT, PRIMARY KEY (source_id, rid))'

/** Provenance of a tag: who applied it. `actor` is null for the analyst's own tags and 'ai' for ones
 *  the AI agent applied — so AI tags can be shown distinctly and rolled up separately. Older
 *  workspaces (created before attribution) lack the column; add it on open. */
function ensureTagActorColumn(db: Database.Database): void {
  const cols = db.prepare('PRAGMA table_info(tags)').all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === 'actor')) db.exec('ALTER TABLE tags ADD COLUMN actor TEXT')
}

/** The analyst's grouping label for a source (the Timeline's Host). Workspaces created before grouping
 *  shipped lack the column; add it on open. */
function ensureSourceGroupColumn(db: Database.Database): void {
  const cols = db.prepare('PRAGMA table_info(sources)').all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === 'group_label')) db.exec('ALTER TABLE sources ADD COLUMN group_label TEXT')
}

/** `numeric` arrived after sorting shipped, so a workspace made before it lacks the column. Add it on
 *  open; the flag stays 0 for those sources, which means they keep the old text-sort behaviour rather
 *  than silently changing order under an analyst who already knows their case. */
function ensureSourceColumnNumeric(db: Database.Database): void {
  const cols = db.prepare('PRAGMA table_info(source_columns)').all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === 'numeric')) db.exec('ALTER TABLE source_columns ADD COLUMN numeric INTEGER')
}

// Intel-sweep results: one row per (source row, matched indicator). A row with ≥1 entry here is a
// "sighting". Keyed independently of `tags`, so a row can carry an intent tag AND be a sighting.
const INTEL_HITS_DDL =
  'CREATE TABLE IF NOT EXISTS intel_hits (source_id INTEGER NOT NULL, rid INTEGER NOT NULL, indicator TEXT NOT NULL, kind TEXT NOT NULL, hitset TEXT, PRIMARY KEY (source_id, rid, indicator))'

// AI-accountability marks (✨): one row per row the AI agent flagged while asserting something
// during triage. Its OWN dimension (independent of intent `tags` and `intel_hits`), so the analyst
// can filter to exactly what the agent touched. `note` records what it asserted. Append-only by
// design — the agent can add marks (no confirmation) but nothing here edits other data.
const AI_MARKS_DDL =
  'CREATE TABLE IF NOT EXISTS ai_marks (source_id INTEGER NOT NULL, rid INTEGER NOT NULL, note TEXT, created_at INTEGER, PRIMARY KEY (source_id, rid))'

// Events (the Artifact Constellation's real substrate): an EVENT is an action that transpired on the
// system (a TTP). `event_evidence` records the specific rows across artifacts that corroborate it —
// many per event, possibly several in one source (rowid PK, unlike finding_hits). An event is stored
// only when it has ≥1 validated evidence row. Each evidence carries the `matched` term (so the
// constellation can pivot to those exact rows). `technique` is an optional ATT&CK attribution.
const EVENTS_DDL =
  'CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, label TEXT NOT NULL, description TEXT, technique TEXT, created_at INTEGER, actor TEXT, uncertainty TEXT)'
// `why` is the agent's per-row rationale for THIS evidence item — the note an analyst reads to audit a
// cited row ("this is the wmiexec output filename, session-unique"). Distinct from the event's overall
// description; nullable.
const EVENT_EVIDENCE_DDL =
  'CREATE TABLE IF NOT EXISTS event_evidence (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL, source_id INTEGER NOT NULL, source_name TEXT, matched TEXT, count INTEGER, rids TEXT, ts_min INTEGER, ts_max INTEGER, why TEXT)'
// Per-time-column spans of an evidence item (one row per time column, kind = the source's column
// header). The Timeline expands these into one row per (evidence, kind); event_evidence.ts_min/max is
// just the envelope across them. evidence_id → event_evidence.id (cleaned up alongside it).
const EVIDENCE_TIMES_DDL =
  'CREATE TABLE IF NOT EXISTS evidence_times (id INTEGER PRIMARY KEY AUTOINCREMENT, evidence_id INTEGER NOT NULL, kind TEXT NOT NULL, col_ref TEXT, ts_min INTEGER, ts_max INTEGER)'
// Entities an event INVOLVES — curated, event-level attribution (the "user attribution" model). v1 only
// stores kind='user' (the account(s) an event involves, e.g. a Hayabusa logon's user); the `kind` column
// leaves room for other entity types later without a migration. Optional (an event need not involve a
// user). event_id → events.id (no FK cascade; cleaned up alongside the event).
const EVENT_ENTITIES_DDL =
  'CREATE TABLE IF NOT EXISTS event_entities (event_id TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (event_id, kind, value))'

// AI-recorded LEADS / hypotheses — the AI's UNPROVEN inferences, kept SEPARATE from proven events so
// they never masquerade as fact. Grounding rows are validated like evidence (a lead must cite the rows
// that prompted it — no ungrounded vibes). Surfaced in the Investigation panel; the analyst pivots to
// the grounding rows, PROMOTES a lead to a real event once evidence earns it, or dismisses it.
const LEADS_DDL =
  'CREATE TABLE IF NOT EXISTS leads (id TEXT PRIMARY KEY, statement TEXT NOT NULL, why_uncertain TEXT, next_step TEXT, created_at INTEGER, status TEXT, resolution TEXT, resolved_at INTEGER, superseded_by TEXT, promoted_event_id TEXT)'

/** Resolution columns were added after the table shipped — back-fill older workspaces on open. A NULL
 *  status reads as 'open'. Leads RESOLVE rather than vanish: a refuted lead is itself a durable record
 *  (the AI considered it and ruled it out), and a stale open lead misrepresents confidence. */
function ensureLeadStatusColumns(db: Database.Database): void {
  const cols = db.prepare('PRAGMA table_info(leads)').all() as Array<{ name: string }>
  const has = (n: string): boolean => cols.some((c) => c.name === n)
  if (!has('status')) db.exec('ALTER TABLE leads ADD COLUMN status TEXT')
  if (!has('resolution')) db.exec('ALTER TABLE leads ADD COLUMN resolution TEXT')
  if (!has('resolved_at')) db.exec('ALTER TABLE leads ADD COLUMN resolved_at INTEGER')
  if (!has('superseded_by')) db.exec('ALTER TABLE leads ADD COLUMN superseded_by TEXT')
  if (!has('promoted_event_id')) db.exec('ALTER TABLE leads ADD COLUMN promoted_event_id TEXT')
}
const LEAD_GROUNDING_DDL =
  'CREATE TABLE IF NOT EXISTS lead_grounding (id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id TEXT NOT NULL, source_id INTEGER NOT NULL, source_name TEXT, matched TEXT, count INTEGER, rids TEXT, spans TEXT, ts_min INTEGER, ts_max INTEGER)'

/** Normalize a curated user-entity set: trim, drop blanks, dedup case-insensitively (keep first-seen
 *  display form), cap each value's length and the overall count. */
function normalizeUsers(users: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of users) {
    const v = String(raw ?? '').trim().slice(0, 120)
    if (!v) continue
    const key = v.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(v)
    if (out.length >= 32) break
  }
  return out
}

/** ts_min/ts_max (the evidence rows' epoch-second time span, for the constellation time axis) were
 *  added after the table shipped; add them to older workspaces on open. Null span = undated evidence. */
function ensureEvidenceTimeColumns(db: Database.Database): void {
  const cols = db.prepare('PRAGMA table_info(event_evidence)').all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === 'ts_min')) db.exec('ALTER TABLE event_evidence ADD COLUMN ts_min INTEGER')
  if (!cols.some((c) => c.name === 'ts_max')) db.exec('ALTER TABLE event_evidence ADD COLUMN ts_max INTEGER')
  // `why` arrived after the table shipped — back-fill older workspaces (reads back null).
  if (!cols.some((c) => c.name === 'why')) db.exec('ALTER TABLE event_evidence ADD COLUMN why TEXT')
}

/** `actor` ('ai' | 'analyst') marks who authored an event's interpretation — added after the table
 *  shipped; back-fill older workspaces (a NULL actor is read as 'ai'). Lets analyst-authored events be
 *  flagged in the UI and protected from being overwritten by the AI's record_event. */
function ensureEventActorColumn(db: Database.Database): void {
  const cols = db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === 'actor')) db.exec('ALTER TABLE events ADD COLUMN actor TEXT')
  // What about this event is UNSETTLED — added after events shipped, so older workspaces read null
  // (nothing unsettled was recorded, which is the honest default).
  if (!cols.some((c) => c.name === 'uncertainty')) db.exec('ALTER TABLE events ADD COLUMN uncertainty TEXT')
}

// IOC catalog: indicators the AI (or analyst) encounters during the investigation, typed by a fixed
// taxonomy. Workspace-level (not per-source). This is just a catalog — nothing here pushes to the
// Intel/enrichment grid; sending an (enrichable) IOC there is a deliberate human action.
const IOCS_DDL =
  'CREATE TABLE IF NOT EXISTS iocs (id TEXT PRIMARY KEY, value TEXT NOT NULL, type TEXT NOT NULL, context TEXT, created_at INTEGER)'
// Which sources the AI agent has examined (triage coverage). Persisted so coverage survives a
// session/Continue boundary — the agent resumes without re-touching already-examined sources. Source
// of truth is the live data; this just records "the agent has opened and read this source's data".
const AI_COVERAGE_DDL = 'CREATE TABLE IF NOT EXISTS ai_coverage (source_id INTEGER PRIMARY KEY, examined_at INTEGER)'

// Every SQL statement the AI agent ran against this case — including the ones that were REFUSED or
// errored. An agent that can compose arbitrary queries must leave a trail the analyst can audit
// after the fact: "what did it actually ask the database?" is otherwise unanswerable, and a refusal
// is the most interesting entry of all because it shows what the agent TRIED to do.
// Lives in the workspace file, so the record travels with the case and survives a restart.
const AI_SQL_LOG_DDL =
  'CREATE TABLE IF NOT EXISTS ai_sql_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ran_at INTEGER, sql TEXT, outcome TEXT, row_count INTEGER, elapsed_ms INTEGER, detail TEXT)'

export interface AgentSqlEntry {
  /** 'ok' | 'refused' (the guard rejected it) | 'error' (SQLite or the runner failed). */
  outcome: 'ok' | 'refused' | 'error'
  sql: string
  rowCount?: number
  elapsedMs?: number
  /** Refusal reason, error message, or the truncation note — whatever explains the outcome. */
  detail?: string | null
}

/** Record one agent SQL attempt. Never throws: an audit write must not fail the caller's query, and
 *  a lost log line is better than a lost result — but see listAgentSql, which is how it's read back. */
export function logAgentSql(wsId: string, entry: AgentSqlEntry): void {
  const w = workspaces.get(wsId)
  if (!w) return
  try {
    w.db.exec(AI_SQL_LOG_DDL) // workspaces created before this shipped won't have the table
    w.db
      .prepare('INSERT INTO ai_sql_log (ran_at, sql, outcome, row_count, elapsed_ms, detail) VALUES (?, ?, ?, ?, ?, ?)')
      .run(Date.now(), entry.sql, entry.outcome, entry.rowCount ?? null, entry.elapsedMs ?? null, entry.detail ?? null)
  } catch {
    /* auditing is best-effort; never break the investigation over it */
  }
}

/** The agent's SQL history for this case, newest first. */
export function listAgentSql(wsId: string, limit = 200): Array<AgentSqlEntry & { id: number; ranAt: number }> {
  const w = workspaces.get(wsId)
  // Throw rather than return [] — an empty array would read as "the agent ran no SQL", which is the
  // opposite of what an unopened workspace means, and an audit trail that under-reports silently is
  // worse than one that errors.
  if (!w) throw new Error(`Workspace not open: ${wsId}`)
  try {
    w.db.exec(AI_SQL_LOG_DDL)
    const rows = w.db
      .prepare('SELECT id, ran_at, sql, outcome, row_count, elapsed_ms, detail FROM ai_sql_log ORDER BY id DESC LIMIT ?')
      .all(Math.max(1, Math.min(limit, 1000))) as Array<{
      id: number
      ran_at: number
      sql: string
      outcome: string
      row_count: number | null
      elapsed_ms: number | null
      detail: string | null
    }>
    return rows.map((r) => ({
      id: r.id,
      ranAt: r.ran_at,
      sql: r.sql,
      outcome: (r.outcome as AgentSqlEntry['outcome']) ?? 'ok',
      rowCount: r.row_count ?? undefined,
      elapsedMs: r.elapsed_ms ?? undefined,
      detail: r.detail
    }))
  } catch {
    return []
  }
}

/** Every tag in a source, as {rid, tag, actor} — the renderer holds these in a Map for markers.
 *  `actor` is null for analyst tags, 'ai' for agent-applied ones. */
export function listTags(wsId: string, sourceId: number): Array<{ rid: number; tag: string; actor: string | null }> {
  const w = workspaces.get(wsId)
  if (!w || !Number.isInteger(sourceId)) return []
  return w.db.prepare('SELECT rid, tag, actor FROM tags WHERE source_id = ?').all(sourceId) as Array<{
    rid: number
    tag: string
    actor: string | null
  }>
}

/** Set (or, when tag is null, clear) the tag on a set of rows. `actor` records provenance (null =
 *  analyst, 'ai' = agent). */
export function setTags(wsId: string, sourceId: number, rids: number[], tag: string | null, actor: string | null = null): void {
  const w = workspaces.get(wsId)
  if (!w || !Number.isInteger(sourceId) || !Array.isArray(rids)) return
  const ids = rids.filter((r) => Number.isInteger(r))
  if (ids.length === 0) return
  if (tag == null) {
    const del = w.db.prepare('DELETE FROM tags WHERE source_id = ? AND rid = ?')
    w.db.transaction(() => ids.forEach((r) => del.run(sourceId, r)))()
  } else {
    const now = Date.now()
    const up = w.db.prepare(
      'INSERT INTO tags (source_id, rid, tag, updated_at, actor) VALUES (?, ?, ?, ?, ?) ' +
        'ON CONFLICT(source_id, rid) DO UPDATE SET tag = excluded.tag, updated_at = excluded.updated_at, actor = excluded.actor'
    )
    w.db.transaction(() => ids.forEach((r) => up.run(sourceId, r, tag, now, actor)))()
  }
  // A materialized filter index that includes a tag predicate is now stale; drop the cache so the
  // next count/query rebuilds it (the renderer re-counts when a tag filter is active).
  const e = tables.get(sourceKey(wsId, sourceId))
  if (e) e.filt = undefined
}

/**
 * Bulk-tag (or clear) every row matching the current view (filters + search) in one statement —
 * reaches the whole match set, not just the loaded window. Returns the number of rows affected.
 */
export function tagByFilter(
  wsId: string,
  sourceId: number,
  filters: Filter[] | undefined,
  search: string | undefined,
  tag: string | null,
  actor: string | null = null
): { count: number } {
  const w = workspaces.get(wsId)
  const e = tables.get(sourceKey(wsId, sourceId))
  if (!w || !e || !Number.isInteger(sourceId)) return { count: 0 }
  const cols = e.meta.columns
  const q =
    tag == null
      ? buildTagClearByFilterSql(cols, filters, search, sourceId, e.table)
      : buildTagApplyByFilterSql(cols, filters, search, sourceId, tag, Date.now(), e.table, actor)
  const info = w.db.prepare(q.sql).run(...q.params)
  e.filt = undefined // matching set's tags changed → invalidate the cached filter index
  return { count: info.changes }
}

// ---- AI-accountability marks (✨): the AI agent's own append-only mark dimension ----

/** All AI marks in a source, as {rid, note} — the renderer holds these in a Map for the ✨ marker. */
export function listAiMarks(wsId: string, sourceId: number): Array<{ rid: number; note: string | null }> {
  const w = workspaces.get(wsId)
  if (!w || !Number.isInteger(sourceId)) return []
  w.db.exec(AI_MARKS_DDL)
  return w.db.prepare('SELECT rid, note FROM ai_marks WHERE source_id = ?').all(sourceId) as Array<{ rid: number; note: string | null }>
}

/** Add an AI mark to a set of rows by explicit rowid (the value-targeting path). Upserts the note. */
export function setAiMarks(wsId: string, sourceId: number, rids: number[], note: string | null = null): { count: number } {
  const w = workspaces.get(wsId)
  if (!w || !Number.isInteger(sourceId) || !Array.isArray(rids)) return { count: 0 }
  const ids = rids.filter((r) => Number.isInteger(r))
  if (ids.length === 0) return { count: 0 }
  w.db.exec(AI_MARKS_DDL)
  const now = Date.now()
  const up = w.db.prepare(
    'INSERT INTO ai_marks (source_id, rid, note, created_at) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT(source_id, rid) DO UPDATE SET note = excluded.note, created_at = excluded.created_at'
  )
  w.db.transaction(() => ids.forEach((r) => up.run(sourceId, r, note, now)))()
  const e = tables.get(sourceKey(wsId, sourceId))
  if (e) e.filt = undefined
  return { count: ids.length }
}

/** Add an AI mark to every row matching the view (filters + search) in one statement. */
export function aiMarkByFilter(
  wsId: string,
  sourceId: number,
  filters: Filter[] | undefined,
  search: string | undefined,
  note: string | null = null
): { count: number } {
  const w = workspaces.get(wsId)
  const e = tables.get(sourceKey(wsId, sourceId))
  if (!w || !e || !Number.isInteger(sourceId)) return { count: 0 }
  w.db.exec(AI_MARKS_DDL)
  const q = buildAiMarkApplyByFilterSql(e.meta.columns, filters, search, sourceId, note, Date.now(), e.table)
  const info = w.db.prepare(q.sql).run(...q.params)
  e.filt = undefined
  return { count: info.changes }
}

/** Clear every AI mark in a source (a "reset the agent's marks" / new-investigation action). */
export function clearAiMarks(wsId: string, sourceId: number): void {
  const w = workspaces.get(wsId)
  if (!w || !Number.isInteger(sourceId)) return
  w.db.prepare('DELETE FROM ai_marks WHERE source_id = ?').run(sourceId)
  const e = tables.get(sourceKey(wsId, sourceId))
  if (e) e.filt = undefined
}

/** Parse a stored rids JSON array defensively — a malformed value must never break a read. */
function safeRids(s: string): number[] {
  try {
    const a = JSON.parse(s)
    return Array.isArray(a) ? a.filter((n) => Number.isInteger(n)) : []
  } catch {
    return []
  }
}

// ---- Events (Artifact Constellation substrate) ----

/** One time column's epoch-second span over an evidence item's matched rows. `kind` is the column's
 *  display header verbatim ("Created0x10", "Modified", …) — the Timeline emits one row per kind. */
export interface EvidenceSpan {
  kind: string
  colRef: string | null
  tsMin: number
  tsMax: number
}
export interface EventEvidence {
  /** event_evidence row id — present on READ (listEvents), used to target a single evidence row for
   *  re-grouping/removal. Absent on write (recordEvent assigns it). */
  id?: number
  sourceId: number
  sourceName: string
  matched: string
  count: number
  rids: number[]
  /** Per-time-column spans (Created vs Modified kept distinct) — the Timeline substrate. Optional on
   *  write; when present, the envelope below is derived from it. */
  spans?: EvidenceSpan[]
  /** Epoch-second envelope across the spans (whole-evidence span for the constellation axis); null when
   *  the evidence has no parseable time. */
  tsMin: number | null
  tsMax: number | null
  /** The agent's per-row rationale for this evidence item (nullable). Read + write. */
  why?: string | null
}
export interface EventRecord {
  id: string
  label: string
  /** Omit (undefined) to LEAVE the existing value untouched on a re-record; pass null to clear it.
   *  Adding corroboration to an event is the most routine call in the workflow, and treating an
   *  omitted field as "set to null" silently destroyed the event's interpretation. */
  description?: string | null
  technique?: string | null
  /**
   * What about this event is UNSETTLED, in words.
   *
   * Evidence proves an event OCCURRED; it does not settle what the occurrence MEANS. A memory-dumping
   * tool that ran inside an attacker window, but sat on disk a week early beside 7-Zip and Notepad++,
   * is a confirmed execution with a genuinely 50/50 attribution. Recording it as a plain event made it
   * render identically to a DCSync — false certainty on a contested reading — and demoting it to a
   * lead would have been wrong, because the execution is not in doubt.
   *
   * Deliberately a SENTENCE, not a score. An LLM emitting `confidence: 0.85` is generating a
   * plausible number rather than measuring anything, and false precision is the last thing this record
   * needs. Naming what specifically is unsettled is both more useful and more honest — and it gives
   * the analyst something to argue WITH when they disagree.
   *
   * Same omit/null contract as description: undefined leaves it, null clears it.
   */
  uncertainty?: string | null
  /** User account(s) the event involves (curated attribution). Omit (undefined) to leave any existing
   *  set untouched on re-record; pass [] to explicitly clear. */
  users?: string[]
}

/** Upsert an event and MERGE in its evidence (additive, deduped by source_id+matched). Merge — not
 *  replace — so the agent can corroborate the same event across more artifacts over several
 *  record_event calls, and each call's evidence accumulates instead of clobbering the last. Re-supplying
 *  the same (source, matched) is idempotent (count/rids refreshed); new (source, matched) pairs append. */
export function recordEvent(
  wsId: string,
  event: EventRecord,
  evidence: EventEvidence[],
  actor: 'ai' | 'analyst' = 'ai',
  /** Replace this event's evidence entirely instead of merging — lets a re-record with tighter scoping
   *  drop an earlier sloppy item rather than leaving both attached. */
  replace = false
): void {
  const w = workspaces.get(wsId)
  if (!w) return
  w.db.exec(EVENTS_DDL)
  w.db.exec(EVENT_EVIDENCE_DDL)
  w.db.exec(EVIDENCE_TIMES_DDL)
  w.db.exec(EVENT_ENTITIES_DDL)
  ensureEvidenceTimeColumns(w.db)
  ensureEventActorColumn(w.db)
  // Protect analyst interpretation: an AI re-record must not clobber (or merge evidence into) an event
  // the analyst has taken ownership of. The analyst path always wins.
  if (actor !== 'analyst') {
    const owner = (w.db.prepare('SELECT actor FROM events WHERE id = ?').get(event.id) as { actor: string | null } | undefined)?.actor
    if (owner === 'analyst') return
  }
  // Preserve interpretation the caller didn't supply. The upsert below writes every column, so an
  // omitted description/technique would otherwise be written as NULL and wipe a prior ATT&CK mapping.
  const prev = w.db.prepare('SELECT description, technique, uncertainty FROM events WHERE id = ?').get(event.id) as
    | { description: string | null; technique: string | null; uncertainty: string | null }
    | undefined
  const description = event.description !== undefined ? event.description : (prev?.description ?? null)
  const technique = event.technique !== undefined ? event.technique : (prev?.technique ?? null)
  const uncertainty = event.uncertainty !== undefined ? event.uncertainty : (prev?.uncertainty ?? null)
  const now = Date.now()
  const upE = w.db.prepare(
    'INSERT INTO events (id, label, description, technique, created_at, actor, uncertainty) VALUES (?, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET label = excluded.label, description = excluded.description, technique = excluded.technique, actor = excluded.actor, uncertainty = excluded.uncertainty'
  )
  // Clean an evidence row's per-kind spans before deleting the row itself (no FK cascade configured).
  const delTimes = w.db.prepare(
    'DELETE FROM evidence_times WHERE evidence_id IN (SELECT id FROM event_evidence WHERE event_id = ? AND source_id = ? AND matched IS ?)'
  )
  const delOne = w.db.prepare('DELETE FROM event_evidence WHERE event_id = ? AND source_id = ? AND matched IS ?')
  const insEv = w.db.prepare('INSERT INTO event_evidence (event_id, source_id, source_name, matched, count, rids, ts_min, ts_max, why) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
  const insTime = w.db.prepare('INSERT INTO evidence_times (evidence_id, kind, col_ref, ts_min, ts_max) VALUES (?, ?, ?, ?, ?)')
  const delUsers = w.db.prepare("DELETE FROM event_entities WHERE event_id = ? AND kind = 'user'")
  const insUser = w.db.prepare("INSERT OR IGNORE INTO event_entities (event_id, kind, value) VALUES (?, 'user', ?)")
  w.db.transaction(() => {
    upE.run(event.id, event.label, description, technique, now, actor, uncertainty)
    if (replace) {
      // Drop every prior evidence row (and its per-kind spans) so only this call's evidence remains.
      w.db.prepare('DELETE FROM evidence_times WHERE evidence_id IN (SELECT id FROM event_evidence WHERE event_id = ?)').run(event.id)
      w.db.prepare('DELETE FROM event_evidence WHERE event_id = ?').run(event.id)
    }
    // Replace the curated user set only when supplied. undefined = leave untouched (so a later AI
    // record_event that omits users doesn't wipe a prior call's set); [] = explicitly clear.
    if (event.users !== undefined) {
      delUsers.run(event.id)
      for (const u of normalizeUsers(event.users)) insUser.run(event.id, u)
    }
    // Dedup within this call by (source_id, matched), then upsert each — refreshing a repeat, appending the new.
    const seen = new Set<string>()
    for (const e of evidence) {
      const key = `${e.sourceId}\0${e.matched}`
      if (seen.has(key)) continue
      seen.add(key)
      delTimes.run(event.id, e.sourceId, e.matched)
      delOne.run(event.id, e.sourceId, e.matched)
      // Derive the envelope from the per-kind spans when supplied; fall back to whatever was passed.
      // Derive the envelope from the per-kind spans, but only from PLAUSIBLE timestamps — a sentinel
      // (1970) or future-dated (2079) value must not anchor the event. The spans themselves are stored
      // unchanged, so evidence_times still reports the bogus value for the analyst to see.
      // Same two filters the tool layer applies (ai/timecols envelopeOf): only columns that MEAN
      // "when this happened" may date the event — a collection stamp or a LNK target's own MACE is a
      // real timestamp of the wrong thing — and only plausible values within those. Every span is
      // still stored unchanged below, so evidence_times reports them all.
      const spans = e.spans ?? []
      const dating = spans.filter((s) => isEventTime(s.kind))
      const considered = dating.length > 0 ? dating : spans
      const real = considered.flatMap((s) => [s.tsMin, s.tsMax]).filter((t) => isPlausibleEpoch(t))
      const tsMin = real.length ? Math.min(...real) : spans.length ? null : e.tsMin
      const tsMax = real.length ? Math.max(...real) : spans.length ? null : e.tsMax
      const evId = insEv.run(event.id, e.sourceId, e.sourceName, e.matched, e.count, JSON.stringify(e.rids), tsMin, tsMax, e.why != null ? String(e.why).slice(0, 1000) : null).lastInsertRowid
      for (const s of spans) insTime.run(evId, s.kind, s.colRef, s.tsMin, s.tsMax)
    }
  })()
}

/** One event's interpretation fields (no evidence) — used when ATTACHING new evidence to an existing
 *  event so its label/description/technique/actor are preserved (the merge in recordEvent re-writes
 *  them, so we pass back the current values). Returns null if the event is gone. */
export function getEvent(wsId: string, id: string): { id: string; label: string; description: string | null; technique: string | null; actor: 'ai' | 'analyst' } | null {
  const w = workspaces.get(wsId)
  if (!w) return null
  w.db.exec(EVENTS_DDL)
  ensureEventActorColumn(w.db)
  const r = w.db.prepare('SELECT id, label, description, technique, actor FROM events WHERE id = ?').get(id) as
    | { id: string; label: string; description: string | null; technique: string | null; actor: string | null }
    | undefined
  if (!r) return null
  return { id: r.id, label: r.label, description: r.description ?? null, technique: r.technique ?? null, actor: r.actor === 'analyst' ? 'analyst' : 'ai' }
}

/** All events in a workspace, each with its evidence. `actor` flags analyst-authored events; each
 *  evidence carries its row id so the UI can target a single piece for re-grouping. */
export function listEvents(wsId: string): Array<EventRecord & { createdAt: number; actor: 'ai' | 'analyst'; hosts: string[]; evidence: EventEvidence[] }> {
  const w = workspaces.get(wsId)
  if (!w) return []
  w.db.exec(EVENTS_DDL)
  w.db.exec(EVENT_EVIDENCE_DDL)
  w.db.exec(EVIDENCE_TIMES_DDL)
  w.db.exec(EVENT_ENTITIES_DDL)
  ensureEvidenceTimeColumns(w.db)
  ensureEventActorColumn(w.db)
  const events = w.db.prepare('SELECT id, label, description, technique, created_at, actor, uncertainty FROM events ORDER BY created_at').all() as Array<{
    id: string
    label: string
    description: string | null
    technique: string | null
    created_at: number
    actor: string | null
    uncertainty: string | null
  }>
  const evStmt = w.db.prepare('SELECT id, source_id, source_name, matched, count, rids, ts_min, ts_max, why FROM event_evidence WHERE event_id = ? ORDER BY id')
  const spStmt = w.db.prepare('SELECT kind, col_ref, ts_min, ts_max FROM evidence_times WHERE evidence_id = ? ORDER BY id')
  const usrStmt = w.db.prepare("SELECT value FROM event_entities WHERE event_id = ? AND kind = 'user' ORDER BY value")
  // Which HOST(S) each event happened on, derived from the group of every source its evidence cites.
  //
  // Derived rather than stored, for the same reason an entity's `collected` is: set_source_group can
  // re-attribute a source at any time, and a stored copy would quietly disagree with the sidebar.
  //
  // An ARRAY, not a single value: a lateral-movement event legitimately has evidence on both ends of
  // the connection, and collapsing that to one host would misattribute half of it. Multi-host is a
  // signal worth seeing, not a case to normalize away.
  const groupOfSource = new Map<number, string>()
  for (const r of w.db.prepare('SELECT id, group_label FROM sources').all() as Array<{ id: number; group_label: string | null }>) {
    if (r.group_label) groupOfSource.set(r.id, r.group_label)
  }
  const hostsOf = (eventId: string): string[] => {
    const out = new Set<string>()
    for (const r of w.db.prepare('SELECT DISTINCT source_id FROM event_evidence WHERE event_id = ?').all(eventId) as Array<{ source_id: number }>) {
      const g = groupOfSource.get(r.source_id)
      if (g) out.add(g)
    }
    return [...out].sort()
  }
  return events.map((e) => ({
    id: e.id,
    label: e.label,
    description: e.description,
    technique: e.technique,
    uncertainty: e.uncertainty,
    createdAt: e.created_at,
    actor: e.actor === 'analyst' ? 'analyst' : 'ai',
    users: (usrStmt.all(e.id) as Array<{ value: string }>).map((u) => u.value),
    hosts: hostsOf(e.id),
    evidence: (evStmt.all(e.id) as Array<{ id: number; source_id: number; source_name: string; matched: string; count: number; rids: string; ts_min: number | null; ts_max: number | null; why: string | null }>).map((v) => ({
      id: v.id,
      sourceId: v.source_id,
      sourceName: v.source_name,
      matched: v.matched,
      count: v.count,
      rids: safeRids(v.rids),
      spans: (spStmt.all(v.id) as Array<{ kind: string; col_ref: string | null; ts_min: number; ts_max: number }>).map((s) => ({
        kind: s.kind,
        colRef: s.col_ref,
        tsMin: s.ts_min,
        tsMax: s.ts_max
      })),
      tsMin: v.ts_min ?? null,
      tsMax: v.ts_max ?? null,
      why: v.why ?? null
    }))
  }))
}

/** One-off repair of records written before two fixes landed. Idempotent and cheap, so it runs on
 *  workspace open rather than asking the analyst to re-record:
 *   • source_name held the BARE filename, so a legacy row and a newly path-qualified row for the SAME
 *     file showed up as two sources (one file counted twice).
 *   • ts_min/ts_max were derived with a raw min/max, so events keep a 1970 or 2079 sentinel span.
 *  Both are recomputed from data already stored (evidence_times + the source's current group). */
function backfillEvidence(w: Workspace): void {
  w.db.exec(EVENTS_DDL)
  w.db.exec(EVENT_EVIDENCE_DDL)
  w.db.exec(EVIDENCE_TIMES_DDL)
  ensureEvidenceTimeColumns(w.db)
  const groups = new Map<number, { name: string; group: string | null }>()
  for (const r of w.db.prepare('SELECT id, name, group_label FROM sources').all() as Array<{ id: number; name: string; group_label: string | null }>) {
    groups.set(r.id, { name: r.name, group: r.group_label })
  }
  // Lead grounding has the same bare-name problem; heal it with the same map.
  try {
    w.db.exec(LEADS_DDL)
    w.db.exec(LEAD_GROUNDING_DDL)
    const gRows = w.db.prepare('SELECT id, source_id, source_name FROM lead_grounding').all() as Array<{ id: number; source_id: number; source_name: string | null }>
    if (gRows.length > 0) {
      const upG = w.db.prepare('UPDATE lead_grounding SET source_name = ? WHERE id = ?')
      w.db.transaction(() => {
        for (const g of gRows) {
          const src = groups.get(g.source_id)
          if (!src) continue
          const want = src.group ? `${src.group}/${src.name}` : src.name
          if (g.source_name !== want) upG.run(want, g.id)
        }
      })()
    }
  } catch {
    /* leads may not exist in an older workspace */
  }
  const rows = w.db.prepare('SELECT id, source_id, source_name, ts_min, ts_max FROM event_evidence').all() as Array<{
    id: number
    source_id: number
    source_name: string | null
    ts_min: number | null
    ts_max: number | null
  }>
  if (rows.length === 0) return
  const spanStmt = w.db.prepare('SELECT ts_min, ts_max FROM evidence_times WHERE evidence_id = ?')
  const upName = w.db.prepare('UPDATE event_evidence SET source_name = ? WHERE id = ?')
  const upSpan = w.db.prepare('UPDATE event_evidence SET ts_min = ?, ts_max = ? WHERE id = ?')
  w.db.transaction(() => {
    for (const r of rows) {
      const src = groups.get(r.source_id)
      if (src) {
        const want = src.group ? `${src.group}/${src.name}` : src.name
        if (r.source_name !== want) upName.run(want, r.id)
      }
      // Recompute the envelope from the per-kind spans, counting only plausible timestamps.
      const spans = spanStmt.all(r.id) as Array<{ ts_min: number; ts_max: number }>
      if (spans.length === 0) continue
      const real = spans.flatMap((x) => [x.ts_min, x.ts_max]).filter((t) => isPlausibleEpoch(t))
      const lo = real.length ? Math.min(...real) : null
      const hi = real.length ? Math.max(...real) : null
      if (lo !== r.ts_min || hi !== r.ts_max) upSpan.run(lo, hi, r.id)
    }
  })()
}

export function deleteEvent(wsId: string, id: string): void {
  const w = workspaces.get(wsId)
  if (!w) return
  w.db.exec(EVIDENCE_TIMES_DDL)
  w.db.exec(EVENT_ENTITIES_DDL)
  w.db.transaction(() => {
    w.db.prepare('DELETE FROM evidence_times WHERE evidence_id IN (SELECT id FROM event_evidence WHERE event_id = ?)').run(id)
    w.db.prepare('DELETE FROM event_evidence WHERE event_id = ?').run(id)
    w.db.prepare('DELETE FROM event_entities WHERE event_id = ?').run(id)
    w.db.prepare('DELETE FROM events WHERE id = ?').run(id)
  })()
}

export function clearEvents(wsId: string): void {
  const w = workspaces.get(wsId)
  if (!w) return
  w.db.exec(EVENTS_DDL)
  w.db.exec(EVENT_EVIDENCE_DDL)
  w.db.exec(EVIDENCE_TIMES_DDL)
  w.db.exec(EVENT_ENTITIES_DDL)
  w.db.exec('DELETE FROM evidence_times')
  w.db.exec('DELETE FROM event_evidence')
  w.db.exec('DELETE FROM event_entities')
  w.db.exec('DELETE FROM events')
}

/** Edit an event's INTERPRETATION only (label / description / technique / involved user(s)) and take
 *  analyst ownership of it. Never touches event_evidence/evidence_times — the corroborating rows stay
 *  exactly as recorded. The user set is REPLACED with `fields.users` (empty clears). `technique` should
 *  already be resolved/canonicalized by the caller (see attack.ts resolveTechnique). */
export function updateEvent(
  wsId: string,
  id: string,
  fields: { label: string; description: string | null; technique: string | null; users: string[]; uncertainty?: string | null },
  /** Who is editing. An ANALYST edit takes ownership (protecting it from AI overwrite); an AI edit
   *  correcting its own wording must NOT claim analyst ownership, and must not touch an event the
   *  analyst has already taken over. */
  actor: 'ai' | 'analyst' = 'analyst'
): boolean {
  const w = workspaces.get(wsId)
  if (!w) return false
  w.db.exec(EVENTS_DDL)
  w.db.exec(EVENT_ENTITIES_DDL)
  ensureEventActorColumn(w.db)
  const cur = w.db.prepare('SELECT actor FROM events WHERE id = ?').get(id) as { actor: string | null } | undefined
  if (!cur) return false
  if (actor === 'ai' && cur.actor === 'analyst') return false // analyst interpretation wins
  w.db.transaction(() => {
    // `uncertainty` is OMITTABLE here, unlike the other fields: an analyst fixing a label should not
    // have to restate what was unsettled about the event, and silently clearing it would erase the
    // one thing keeping a contested reading from looking settled.
    if (fields.uncertainty !== undefined) {
      w.db.prepare('UPDATE events SET uncertainty = ? WHERE id = ?').run(
        fields.uncertainty != null ? String(fields.uncertainty).slice(0, 2000) : null,
        id
      )
    }
    w.db.prepare('UPDATE events SET label = ?, description = ?, technique = ?, actor = ? WHERE id = ?').run(
      String(fields.label ?? '').slice(0, 300),
      fields.description != null ? String(fields.description).slice(0, 2000) : null,
      fields.technique != null ? String(fields.technique).slice(0, 200) : null,
      actor,
      id
    )
    w.db.prepare("DELETE FROM event_entities WHERE event_id = ? AND kind = 'user'").run(id)
    const insUser = w.db.prepare("INSERT OR IGNORE INTO event_entities (event_id, kind, value) VALUES (?, 'user', ?)")
    for (const u of normalizeUsers(fields.users ?? [])) insUser.run(id, u)
  })()
  return true
}

/** Remove a single piece of evidence from an event (re-grouping — the analyst judges it doesn't belong),
 *  along with its per-kind spans. The source rows are untouched; the parent event becomes analyst-owned. */
export function deleteEvidence(wsId: string, evidenceId: number): void {
  const w = workspaces.get(wsId)
  if (!w || !Number.isInteger(evidenceId)) return
  w.db.exec(EVENT_EVIDENCE_DDL)
  w.db.exec(EVIDENCE_TIMES_DDL)
  ensureEventActorColumn(w.db)
  w.db.transaction(() => {
    const ev = w.db.prepare('SELECT event_id FROM event_evidence WHERE id = ?').get(evidenceId) as { event_id: string } | undefined
    w.db.prepare('DELETE FROM evidence_times WHERE evidence_id = ?').run(evidenceId)
    w.db.prepare('DELETE FROM event_evidence WHERE id = ?').run(evidenceId)
    if (ev) w.db.prepare("UPDATE events SET actor = 'analyst' WHERE id = ?").run(ev.event_id)
  })()
}

// ---- Leads (AI hypotheses — unproven inferences, separate from proven events) ----

export interface LeadGrounding {
  sourceId: number
  sourceName: string
  matched: string
  count: number
  rids: number[]
  /** Per-time-column spans of the grounding rows — carried so a promoted lead becomes a dated event. */
  spans?: EvidenceSpan[]
  tsMin: number | null
  tsMax: number | null
}
export interface LeadRecord {
  id: string
  statement: string
  whyUncertain: string | null
  nextStep: string | null
}

/** Record (or replace) a lead + its grounding. Unlike events, a lead is REPLACED on re-record by the
 *  same id — it's a single working hypothesis, not an accreting case artifact. */
export function recordLead(wsId: string, lead: LeadRecord, grounding: LeadGrounding[]): void {
  const w = workspaces.get(wsId)
  if (!w) return
  w.db.exec(LEADS_DDL)
  w.db.exec(LEAD_GROUNDING_DDL)
  ensureLeadStatusColumns(w.db)
  const insL = w.db.prepare("INSERT OR REPLACE INTO leads (id, statement, why_uncertain, next_step, created_at, status) VALUES (?, ?, ?, ?, ?, 'open')")
  const delG = w.db.prepare('DELETE FROM lead_grounding WHERE lead_id = ?')
  const insG = w.db.prepare('INSERT INTO lead_grounding (lead_id, source_id, source_name, matched, count, rids, spans, ts_min, ts_max) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
  w.db.transaction(() => {
    insL.run(lead.id, lead.statement, lead.whyUncertain, lead.nextStep, Date.now())
    delG.run(lead.id)
    for (const g of grounding) insG.run(lead.id, g.sourceId, g.sourceName, g.matched, g.count, JSON.stringify(g.rids), g.spans ? JSON.stringify(g.spans) : null, g.tsMin, g.tsMax)
  })()
}

export type LeadStatus = 'open' | 'refuted' | 'superseded' | 'promoted'
export interface LeadOut {
  id: string
  statement: string
  whyUncertain: string | null
  nextStep: string | null
  createdAt: number
  status: LeadStatus
  /** Why it was closed — the durable record of a negative result. */
  resolution: string | null
  resolvedAt: number | null
  supersededBy: string | null
  promotedEventId: string | null
  grounding: Array<{ id: number; sourceId: number; sourceName: string; matched: string; count: number; rids: number[]; tsMin: number | null; tsMax: number | null }>
}

export function listLeads(wsId: string): LeadOut[] {
  const w = workspaces.get(wsId)
  if (!w) return []
  w.db.exec(LEADS_DDL)
  w.db.exec(LEAD_GROUNDING_DDL)
  ensureLeadStatusColumns(w.db)
  const leads = w.db
    .prepare("SELECT id, statement, why_uncertain, next_step, created_at, COALESCE(status,'open') AS status, resolution, resolved_at, superseded_by, promoted_event_id FROM leads ORDER BY CASE COALESCE(status,'open') WHEN 'open' THEN 0 ELSE 1 END, created_at DESC")
    .all() as Array<{
    id: string
    statement: string
    why_uncertain: string | null
    next_step: string | null
    created_at: number
    status: string
    resolution: string | null
    resolved_at: number | null
    superseded_by: string | null
    promoted_event_id: string | null
  }>
  const gStmt = w.db.prepare('SELECT id, source_id, source_name, matched, count, rids, ts_min, ts_max FROM lead_grounding WHERE lead_id = ? ORDER BY id')
  return leads.map((l) => ({
    id: l.id,
    statement: l.statement,
    whyUncertain: l.why_uncertain,
    nextStep: l.next_step,
    createdAt: l.created_at,
    status: (['open', 'refuted', 'superseded', 'promoted'].includes(l.status) ? l.status : 'open') as LeadStatus,
    resolution: l.resolution,
    resolvedAt: l.resolved_at,
    supersededBy: l.superseded_by,
    promotedEventId: l.promoted_event_id,
    grounding: (gStmt.all(l.id) as Array<{ id: number; source_id: number; source_name: string; matched: string; count: number; rids: string; ts_min: number | null; ts_max: number | null }>).map((g) => ({
      id: g.id,
      sourceId: g.source_id,
      sourceName: g.source_name,
      matched: g.matched,
      count: g.count,
      rids: safeRids(g.rids),
      tsMin: g.ts_min,
      tsMax: g.ts_max
    }))
  }))
}

/** Edit and/or RESOLVE a lead. A resolved lead is kept, not deleted: "I checked and ruled this out"
 *  is a durable negative result worth grading, and leaving it open misrepresents confidence. The text
 *  is editable in place (the id is a slug of the original statement, so re-recording would otherwise
 *  fork a second lead instead of correcting the first). */
export function updateLead(
  wsId: string,
  id: string,
  patch: { statement?: string; whyUncertain?: string | null; nextStep?: string | null; status?: LeadStatus; resolution?: string | null; supersededBy?: string | null }
): boolean {
  const w = workspaces.get(wsId)
  if (!w) return false
  w.db.exec(LEADS_DDL)
  ensureLeadStatusColumns(w.db)
  const cur = w.db.prepare('SELECT id FROM leads WHERE id = ?').get(id) as { id: string } | undefined
  if (!cur) return false
  const sets: string[] = []
  const params: Array<string | number | null> = []
  const put = (col: string, v: string | number | null): void => {
    sets.push(`${col} = ?`)
    params.push(v)
  }
  if (patch.statement !== undefined) put('statement', patch.statement)
  if (patch.whyUncertain !== undefined) put('why_uncertain', patch.whyUncertain)
  if (patch.nextStep !== undefined) put('next_step', patch.nextStep)
  if (patch.resolution !== undefined) put('resolution', patch.resolution)
  if (patch.supersededBy !== undefined) put('superseded_by', patch.supersededBy)
  if (patch.status !== undefined) {
    put('status', patch.status)
    put('resolved_at', patch.status === 'open' ? null : Date.now())
  }
  if (sets.length === 0) return true
  params.push(id)
  w.db.prepare(`UPDATE leads SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  return true
}

export function deleteLead(wsId: string, id: string): void {
  const w = workspaces.get(wsId)
  if (!w) return
  w.db.exec(LEADS_DDL)
  w.db.exec(LEAD_GROUNDING_DDL)
  w.db.transaction(() => {
    w.db.prepare('DELETE FROM lead_grounding WHERE lead_id = ?').run(id)
    w.db.prepare('DELETE FROM leads WHERE id = ?').run(id)
  })()
}

export function clearLeads(wsId: string): void {
  const w = workspaces.get(wsId)
  if (!w) return
  w.db.exec(LEADS_DDL)
  w.db.exec(LEAD_GROUNDING_DDL)
  w.db.exec('DELETE FROM lead_grounding')
  w.db.exec('DELETE FROM leads')
}

/** Promote a lead to a real event: its grounding becomes the event's evidence (spans carried, so it's
 *  dated on the Timeline), then the lead is removed. Returns the new event id, or null if not found. */
export function promoteLead(wsId: string, id: string): string | null {
  const w = workspaces.get(wsId)
  if (!w) return null
  w.db.exec(LEADS_DDL)
  w.db.exec(LEAD_GROUNDING_DDL)
  const lead = w.db.prepare('SELECT id, statement, why_uncertain FROM leads WHERE id = ?').get(id) as { id: string; statement: string; why_uncertain: string | null } | undefined
  if (!lead) return null
  const g = w.db.prepare('SELECT source_id, source_name, matched, count, rids, spans, ts_min, ts_max FROM lead_grounding WHERE lead_id = ?').all(id) as Array<{
    source_id: number
    source_name: string
    matched: string
    count: number
    rids: string
    spans: string | null
    ts_min: number | null
    ts_max: number | null
  }>
  const evidence: EventEvidence[] = g.map((x) => ({
    sourceId: x.source_id,
    sourceName: x.source_name,
    matched: x.matched,
    count: x.count,
    rids: safeRids(x.rids),
    spans: x.spans ? (JSON.parse(x.spans) as EvidenceSpan[]) : undefined,
    tsMin: x.ts_min,
    tsMax: x.ts_max
  }))
  const eventId = `event:${lead.statement.toLowerCase().replace(/\s+/g, '-').slice(0, 80)}`
  // Promoted by the analyst's decision — record as an event (actor 'ai' keeps it corroboratable later).
  recordEvent(wsId, { id: eventId, label: lead.statement, description: lead.why_uncertain, technique: null }, evidence, 'ai')
  // Keep the lead as a RESOLVED record linked to the event, rather than deleting it — the fact that a
  // hypothesis was raised and then earned promotion is part of the reviewable trail.
  ensureLeadStatusColumns(w.db)
  w.db.prepare("UPDATE leads SET status = 'promoted', promoted_event_id = ?, resolved_at = ? WHERE id = ?").run(eventId, Date.now(), id)
  return eventId
}

// ---- Systems & Accounts (entities) ----

// Only the CURATED overlay is stored. The spine — which systems produced sources, which entities the
// recorded events involve — is derived on every read by entityDerive.mergeEntities, because it is a
// pure function of `sources` and `event_entities` and a cached copy could only ever drift out of date.
//
// `collected` is deliberately NOT a column: whether we hold a host's data is a fact about the sources,
// and storing it would let curation claim data the case doesn't have.
const ENTITIES_DDL =
  'CREATE TABLE IF NOT EXISTS entities (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, origin TEXT, status TEXT, role TEXT, notes TEXT, actor TEXT, created_at INTEGER, updated_at INTEGER)'
// Confirmed alternate names for one entity. Written only by an explicit confirmation — aliasSuggestion
// PROPOSES, and nothing merges on its own (see src/shared/entities.ts for why).
const ENTITY_ALIASES_DDL =
  'CREATE TABLE IF NOT EXISTS entity_aliases (entity_id TEXT NOT NULL, alias TEXT NOT NULL, created_at INTEGER, PRIMARY KEY (entity_id, alias))'
// Rows that back an entity's existence — the same shape as lead_grounding, and the mechanism that
// promotes an `asserted` entity to `evidenced`.
const ENTITY_GROUNDING_DDL =
  'CREATE TABLE IF NOT EXISTS entity_grounding (id INTEGER PRIMARY KEY AUTOINCREMENT, entity_id TEXT NOT NULL, source_id INTEGER NOT NULL, source_name TEXT, matched TEXT, count INTEGER, rids TEXT, ts_min INTEGER, ts_max INTEGER)'

function ensureEntityTables(db: Database.Database): void {
  db.exec(ENTITIES_DDL)
  // `actor` arrived after the table shipped; a workspace made before it reads back null, which the
  // panel renders as no author badge rather than guessing one.
  if (!(db.prepare('PRAGMA table_info(entities)').all() as Array<{ name: string }>).some((c) => c.name === 'actor')) {
    db.exec('ALTER TABLE entities ADD COLUMN actor TEXT')
  }
  db.exec(ENTITY_ALIASES_DDL)
  db.exec(ENTITY_GROUNDING_DDL)
  db.exec(EVENT_ENTITIES_DDL)
}

/** Read the derived spine out of sources + event_entities. */
function deriveEntities(db: Database.Database): DerivedEntity[] {
  const out: DerivedEntity[] = []
  // Every source's group is a host whose triage package we actually hold.
  for (const r of db.prepare('SELECT DISTINCT group_label FROM sources WHERE group_label IS NOT NULL AND TRIM(group_label) <> \'\'').all() as Array<{
    group_label: string
  }>) {
    out.push({ kind: 'system', value: r.group_label, collected: true, eventCount: 0 })
  }
  // Entities the recorded events involve. `kind='user'` is the historical name for an account; any
  // other kind is treated as a system, which is what the event-level attribution model stores.
  for (const r of db
    .prepare('SELECT kind, value, COUNT(DISTINCT event_id) AS n FROM event_entities GROUP BY kind, value')
    .all() as Array<{ kind: string; value: string; n: number }>) {
    out.push({
      kind: r.kind === 'user' || r.kind === 'account' ? 'account' : 'system',
      value: r.value,
      collected: false,
      eventCount: r.n
    })
  }
  return out
}

export function listEntities(wsId: string): EntityOut[] {
  const w = workspaces.get(wsId)
  if (!w) return []
  ensureEntityTables(w.db)
  const stored = w.db
    .prepare('SELECT id, kind, name, origin, status, role, notes, actor, created_at, updated_at FROM entities')
    .all() as Array<{
    id: string
    kind: string
    name: string
    origin: string | null
    status: string | null
    role: string | null
    notes: string | null
    actor: string | null
    created_at: number
    updated_at: number
  }>
  const aliasStmt = w.db.prepare('SELECT alias FROM entity_aliases WHERE entity_id = ? ORDER BY alias')
  const groundStmt = w.db.prepare('SELECT COUNT(*) AS n FROM entity_grounding WHERE entity_id = ?')
  return mergeEntities(
    deriveEntities(w.db),
    stored.map((s) => ({
      id: s.id,
      kind: isEntityKind(s.kind) ? s.kind : 'system',
      name: s.name,
      origin: s.origin === 'evidenced' ? 'evidenced' : 'asserted',
      status: isEntityStatus(s.status) ? s.status : 'unknown',
      role: s.role,
      notes: s.notes,
      actor: isEntityActor(s.actor) ? s.actor : null,
      createdAt: s.created_at,
      updatedAt: s.updated_at,
      aliases: (aliasStmt.all(s.id) as Array<{ alias: string }>).map((a) => a.alias),
      groundingCount: (groundStmt.get(s.id) as { n: number }).n
    }))
  )
}

export interface EntityPatch {
  kind: EntityKind
  name: string
  status?: EntityStatus
  role?: string | null
  notes?: string | null
}

/**
 * Create or update a curated entity record. Returns its id.
 *
 * A record whose name the case already evidences is stored as `evidenced`; anything else lands as
 * `asserted` and reads visibly differently, the way an unproven lead does. Nothing is refused — an
 * analyst scoping a case may legitimately name a host before any artifact mentions it.
 */
export function upsertEntity(wsId: string, patch: EntityPatch, grounding: LeadGrounding[] = [], actor: EntityActor = 'analyst'): string | null {
  const w = workspaces.get(wsId)
  if (!w) return null
  const name = String(patch.name ?? '').trim().slice(0, 200)
  if (!name || !isEntityKind(patch.kind)) return null
  ensureEntityTables(w.db)
  const id = entityId(patch.kind, name)
  const now = Date.now()
  const evidencedAlready =
    grounding.length > 0 || deriveEntities(w.db).some((d) => d.kind === patch.kind && entityId(d.kind, d.value) === id)
  const insG = w.db.prepare(
    'INSERT INTO entity_grounding (entity_id, source_id, source_name, matched, count, rids, ts_min, ts_max) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  )
  w.db.transaction(() => {
    w.db
      .prepare(
        'INSERT INTO entities (id, kind, name, origin, status, role, notes, actor, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
          // The analyst's DISPLAY NAME wins over an agent's. Both spellings are the same entity (the
          // id is case-folded), so this only decides what is shown — and an analyst who fixed the
          // casing should not have it silently undone the next time the agent mentions the host.
          "ON CONFLICT(id) DO UPDATE SET name = CASE WHEN entities.actor = 'analyst' AND excluded.actor = 'ai' THEN entities.name ELSE excluded.name END, origin = excluded.origin, " +
          // COALESCE so a partial update (status only) never blanks a field it didn't mention.
          'status = COALESCE(excluded.status, entities.status), role = COALESCE(excluded.role, entities.role), ' +
          // The AUTHOR is whoever created the record; a later edit by the other party doesn't
          // rewrite it, so "the AI added this" stays true after an analyst adjusts the status.
          'notes = COALESCE(excluded.notes, entities.notes), actor = COALESCE(entities.actor, excluded.actor), updated_at = excluded.updated_at'
      )
      .run(
        id,
        patch.kind,
        name,
        evidencedAlready ? 'evidenced' : 'asserted',
        patch.status && isEntityStatus(patch.status) ? patch.status : null,
        patch.role != null ? String(patch.role).slice(0, 200) : null,
        patch.notes != null ? String(patch.notes).slice(0, 4000) : null,
        actor,
        now,
        now
      )
    // Grounding ACCRETES — each hunt that finds the entity adds to the case for it, and re-recording
    // should never discard what an earlier pass established.
    for (const g of grounding) insG.run(id, g.sourceId, g.sourceName, g.matched, g.count, JSON.stringify(g.rids), g.tsMin, g.tsMax)
  })()
  return id
}

// Pairs someone has explicitly judged NOT the same entity. Without this the app keeps proposing a
// link it has already been told is wrong — and the correct answer genuinely differs per pair: two
// domain-qualified forms of one account ARE one principal, while a local and a domain account sharing
// a name are different principals with different SIDs. Both judgements are worth keeping.
const ENTITY_ALIAS_REJECTED_DDL =
  'CREATE TABLE IF NOT EXISTS entity_alias_rejected (entity_id TEXT NOT NULL, other TEXT NOT NULL, reason TEXT, created_at INTEGER, PRIMARY KEY (entity_id, other))'

/**
 * Record a judgement that two names ARE (or are NOT) the same entity.
 *
 * Merging is destructive-ish and evidence-led, so it is never inferred: `aliasSuggestion` proposes,
 * this records the answer. On a merge the other record's aliases and grounding are folded into the
 * primary and its own row is dropped — the entity survives under one identity, keeping both names.
 */
export function linkEntities(
  wsId: string,
  kind: EntityKind,
  primaryName: string,
  otherName: string,
  same: boolean,
  reason: string | null,
  actor: EntityActor = 'analyst'
): { linked: boolean; id: string; merged: boolean; aliases: string[] } | null {
  const w = workspaces.get(wsId)
  if (!w || !isEntityKind(kind)) return null
  const a = String(primaryName ?? '').trim().slice(0, 200)
  const b = String(otherName ?? '').trim().slice(0, 200)
  if (!a || !b) return null
  ensureEntityTables(w.db)
  w.db.exec(ENTITY_ALIAS_REJECTED_DDL)
  const id = entityId(kind, a)
  const otherId = entityId(kind, b)
  if (id === otherId) return { linked: false, id, merged: false, aliases: [] }

  // The primary must exist as a record to hang the judgement on; it may so far be derived-only.
  upsertEntity(wsId, { kind, name: a }, [], actor)

  w.db.transaction(() => {
    if (!same) {
      // `other` holds the NAME, not an id — the same shape entity_aliases uses, so a caller can
      // normalize both the same way. Storing an id here silently double-prefixed it downstream and
      // the rejection never matched, so the app kept re-proposing a link it had been told was wrong.
      w.db
        .prepare('INSERT OR REPLACE INTO entity_alias_rejected (entity_id, other, reason, created_at) VALUES (?, ?, ?, ?)')
        .run(id, b, reason, Date.now())
      return
    }
    w.db.prepare('INSERT OR IGNORE INTO entity_aliases (entity_id, alias, created_at) VALUES (?, ?, ?)').run(id, b, Date.now())
    // Fold the other record in, if it had one of its own, then retire it.
    for (const r of w.db.prepare('SELECT alias FROM entity_aliases WHERE entity_id = ?').all(otherId) as Array<{ alias: string }>) {
      w.db.prepare('INSERT OR IGNORE INTO entity_aliases (entity_id, alias, created_at) VALUES (?, ?, ?)').run(id, r.alias, Date.now())
    }
    w.db.prepare('UPDATE entity_grounding SET entity_id = ? WHERE entity_id = ?').run(id, otherId)
    w.db.prepare('DELETE FROM entity_aliases WHERE entity_id = ?').run(otherId)
    w.db.prepare('DELETE FROM entities WHERE id = ?').run(otherId)
  })()

  const aliases = (w.db.prepare('SELECT alias FROM entity_aliases WHERE entity_id = ? ORDER BY alias').all(id) as Array<{ alias: string }>).map(
    (r) => r.alias
  )
  return { linked: true, id, merged: same, aliases }
}

/** Pairs already judged — so a suggestion is never re-proposed after it has been answered. */
export function listEntityLinkJudgements(wsId: string): Array<{ entityId: string; other: string; same: boolean }> {
  const w = workspaces.get(wsId)
  if (!w) return []
  ensureEntityTables(w.db)
  w.db.exec(ENTITY_ALIAS_REJECTED_DDL)
  const out: Array<{ entityId: string; other: string; same: boolean }> = []
  for (const r of w.db.prepare('SELECT entity_id, other FROM entity_alias_rejected').all() as Array<{ entity_id: string; other: string }>) {
    out.push({ entityId: r.entity_id, other: r.other, same: false })
  }
  for (const r of w.db.prepare('SELECT entity_id, alias FROM entity_aliases').all() as Array<{ entity_id: string; alias: string }>) {
    out.push({ entityId: r.entity_id, other: r.alias, same: true })
  }
  return out
}

/** Confirm two names are the same entity. Recorded, never inferred — see aliasSuggestion. */
export function addEntityAlias(wsId: string, id: string, alias: string): boolean {
  const w = workspaces.get(wsId)
  if (!w) return false
  const a = String(alias ?? '').trim().slice(0, 200)
  if (!a) return false
  ensureEntityTables(w.db)
  if (!w.db.prepare('SELECT id FROM entities WHERE id = ?').get(id)) return false
  w.db.prepare('INSERT OR IGNORE INTO entity_aliases (entity_id, alias, created_at) VALUES (?, ?, ?)').run(id, a, Date.now())
  return true
}

export function removeEntityAlias(wsId: string, id: string, alias: string): void {
  const w = workspaces.get(wsId)
  if (!w) return
  ensureEntityTables(w.db)
  w.db.prepare('DELETE FROM entity_aliases WHERE entity_id = ? AND alias = ?').run(id, alias)
}

/**
 * Delete the CURATED record. The entity itself may survive in the derived spine — if the case's own
 * data names it, deleting a note cannot un-name it — so this reverts curation rather than erasing an
 * observation, which is the honest behaviour.
 */
export function deleteEntity(wsId: string, id: string): void {
  const w = workspaces.get(wsId)
  if (!w) return
  ensureEntityTables(w.db)
  w.db.transaction(() => {
    w.db.prepare('DELETE FROM entity_aliases WHERE entity_id = ?').run(id)
    w.db.prepare('DELETE FROM entity_grounding WHERE entity_id = ?').run(id)
    w.db.prepare('DELETE FROM entities WHERE id = ?').run(id)
  })()
}

// ---- Negative findings ----

// A NEGATIVE is a proven absence: "no ransomware extensions anywhere under Shares after the script
// ran". Until now there was nowhere to put one — record_event validates evidence against real rows
// and refuses when nothing matches, so a proven absence was unrecordable BY CONSTRUCTION. Three
// separate agent runs raised this independently, and the conclusion it cost was not a minor one:
// "this host was not encrypted" is the difference between a data-theft incident and a ransomware
// detonation, and it survived only as a sentence in a report.
//
// What makes a negative trustworthy is that its grounding is COVERAGE, not rows: WHERE you looked,
// FOR WHAT, and OVER WHAT WINDOW. An absence without its scope is unfalsifiable. So the query is
// stored, not just the sentence, which buys two properties nothing else in the app has:
//
//   • RE-VERIFIABLE — the same search can be re-run on demand and either reconfirm the claim or
//     OVERTURN it, and an overturned negative is a major finding rather than an embarrassment.
//   • STALE-ABLE — evidence imported after the claim was established was, by definition, not
//     searched. `max_source_id` records the newest source at the time, so "3 sources arrived since
//     you established this" is derivable rather than something the analyst has to remember.
//
// `kind` separates a claim about the INTRUSION ('absence' — verifiable) from a claim about the
// EVIDENCE ('gap' — a parser that failed, an artifact class nobody could parse). A gap has no query
// to re-run, so it is stored as a statement and never reported as verifiable.
const NEGATIVES_DDL =
  'CREATE TABLE IF NOT EXISTS negatives (id TEXT PRIMARY KEY, kind TEXT NOT NULL, statement TEXT NOT NULL, why_it_matters TEXT, ' +
  'scope_sources TEXT, scope_hosts TEXT, value TEXT, search TEXT, filters TEXT, time_from INTEGER, time_to INTEGER, time_column TEXT, ' +
  'max_source_id INTEGER, established_at INTEGER, actor TEXT, last_verified_at INTEGER, last_result INTEGER, values_json TEXT)'

export type NegativeKind = 'absence' | 'gap'

export interface NegativeScope {
  /** Source ids actually searched. Empty for a `gap`, which has no query. */
  sourceIds: number[]
  /** Host groups the search was scoped to, when it was scoped that way. */
  hosts?: string[]
  value?: string | null
  search?: string | null
  filters?: unknown
  timeFrom?: number | null
  timeTo?: number | null
  timeColumn?: string | null
  /** EVERY term that was searched and found absent. An absence claiming several things ("no .locked,
   *  .encrypted or .lockbit") must have verified each one — storing only the first is how a claim ends
   *  up broader than what was checked. `value` keeps the first for older records/back-compat. */
  values?: string[]
}

export interface NegativeRecord {
  id: string
  kind: NegativeKind
  statement: string
  whyItMatters?: string | null
}

export interface NegativeOut extends NegativeRecord {
  scope: NegativeScope
  establishedAt: number
  actor: 'ai' | 'analyst'
  lastVerifiedAt: number | null
  lastResult: number | null
  /** Sources imported since this was established — they were never searched. */
  newSourcesSince: number
  /** True when new evidence has arrived, so the claim is unverified against the current case. */
  stale: boolean
  /** A gap has no query, so it can never be machine-re-verified. Say so rather than implying it can. */
  verifiable: boolean
}

/** The longest a negative's statement may be. Exported so the tool layer can refuse (with a clear
 *  message) rather than silently truncate a claim the analyst is going to adjudicate. */
export const NEGATIVE_STATEMENT_MAX = 500

/** `values_json` (every searched term) arrived after the table shipped — back-fill older workspaces. */
function ensureNegativeValuesColumn(db: Database.Database): void {
  const cols = db.prepare('PRAGMA table_info(negatives)').all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === 'values_json')) db.exec('ALTER TABLE negatives ADD COLUMN values_json TEXT')
}

function currentMaxSourceId(db: Database.Database): number {
  const r = db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM sources').get() as { m: number }
  return r.m
}

/** Record a proven absence. The CALLER must already have run the search and confirmed 0 rows —
 *  db.ts holds no query engine; the tool layer validates, exactly as it does for event evidence. */
export function recordNegative(wsId: string, rec: NegativeRecord, scope: NegativeScope, actor: 'ai' | 'analyst' = 'ai'): string | null {
  const w = workspaces.get(wsId)
  if (!w) return null
  // NOT clipped: the caller (tool layer) refuses an over-long statement outright, because this text
  // is the claim shown in the Case Report for approval — a sentence cut mid-word is worse than a
  // retry. This stays a hard guard for any direct caller.
  const statement = String(rec.statement ?? '').trim()
  if (!statement || statement.length > NEGATIVE_STATEMENT_MAX) return null
  w.db.exec(NEGATIVES_DDL)
  ensureNegativeValuesColumn(w.db)
  const now = Date.now()
  w.db
    .prepare(
      'INSERT INTO negatives (id, kind, statement, why_it_matters, scope_sources, scope_hosts, value, search, filters, time_from, time_to, time_column, max_source_id, established_at, actor, last_verified_at, last_result, values_json) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET statement = excluded.statement, why_it_matters = excluded.why_it_matters, ' +
        'scope_sources = excluded.scope_sources, scope_hosts = excluded.scope_hosts, value = excluded.value, search = excluded.search, ' +
        'filters = excluded.filters, time_from = excluded.time_from, time_to = excluded.time_to, time_column = excluded.time_column, ' +
        'max_source_id = excluded.max_source_id, established_at = excluded.established_at, last_verified_at = excluded.established_at, last_result = 0, values_json = excluded.values_json'
    )
    .run(
      rec.id,
      rec.kind === 'gap' ? 'gap' : 'absence',
      statement,
      rec.whyItMatters != null ? String(rec.whyItMatters).slice(0, 2000) : null,
      JSON.stringify(scope.sourceIds ?? []),
      scope.hosts && scope.hosts.length ? JSON.stringify(scope.hosts) : null,
      scope.value ?? null,
      scope.search ?? null,
      scope.filters ? JSON.stringify(scope.filters) : null,
      scope.timeFrom ?? null,
      scope.timeTo ?? null,
      scope.timeColumn ?? null,
      currentMaxSourceId(w.db),
      now,
      actor,
      now,
      scope.values && scope.values.length ? JSON.stringify(scope.values) : null
    )
  return rec.id
}

function parseNegJson<T>(s: string | null, fallback: T): T {
  if (!s) return fallback
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}

export function listNegatives(wsId: string): NegativeOut[] {
  const w = workspaces.get(wsId)
  if (!w) return []
  w.db.exec(NEGATIVES_DDL)
  ensureNegativeValuesColumn(w.db)
  const maxNow = currentMaxSourceId(w.db)
  const rows = w.db.prepare('SELECT * FROM negatives ORDER BY established_at').all() as Array<Record<string, unknown>>
  const newerStmt = w.db.prepare('SELECT COUNT(*) AS n FROM sources WHERE id > ?')
  return rows.map((r) => {
    const kind: NegativeKind = r.kind === 'gap' ? 'gap' : 'absence'
    const watermark = Number(r.max_source_id ?? 0)
    // Sources whose id exceeds the watermark did not exist when the claim was established, so the
    // search never covered them. Comparing ids rather than diffing sets keeps this cheap and stays
    // correct when a source is removed (ids are monotonic).
    const newSince = (newerStmt.get(watermark) as { n: number }).n
    const verifiable = kind === 'absence' && (r.value != null || r.search != null || r.filters != null)
    return {
      id: String(r.id),
      kind,
      statement: String(r.statement),
      whyItMatters: (r.why_it_matters as string | null) ?? null,
      scope: {
        sourceIds: parseNegJson<number[]>(r.scope_sources as string | null, []),
        hosts: parseNegJson<string[]>(r.scope_hosts as string | null, []),
        value: (r.value as string | null) ?? null,
        // Older records stored only `value`; treat it as a one-term list so every consumer can just
        // iterate `values` without caring which era the record came from.
        values: parseNegJson<string[]>(r.values_json as string | null, r.value ? [String(r.value)] : []),
        search: (r.search as string | null) ?? null,
        filters: parseNegJson<unknown>(r.filters as string | null, null),
        timeFrom: (r.time_from as number | null) ?? null,
        timeTo: (r.time_to as number | null) ?? null,
        timeColumn: (r.time_column as string | null) ?? null
      },
      establishedAt: Number(r.established_at ?? 0),
      actor: r.actor === 'analyst' ? 'analyst' : 'ai',
      lastVerifiedAt: (r.last_verified_at as number | null) ?? null,
      lastResult: (r.last_result as number | null) ?? null,
      newSourcesSince: newSince,
      stale: verifiable && newSince > 0 && maxNow > watermark,
      verifiable
    }
  })
}

/** Record the outcome of a re-run. `rows` > 0 means the absence no longer holds — the record is KEPT
 *  and marked, because "this used to be true and no longer is" is itself a finding. */
export function setNegativeVerification(wsId: string, id: string, rows: number): void {
  const w = workspaces.get(wsId)
  if (!w) return
  w.db.exec(NEGATIVES_DDL)
  // The watermark advances only when the claim still HOLDS. An overturned negative must stay flagged
  // rather than being quietly re-baselined against the very evidence that broke it.
  if (rows === 0) {
    w.db
      .prepare('UPDATE negatives SET last_verified_at = ?, last_result = 0, max_source_id = ? WHERE id = ?')
      .run(Date.now(), currentMaxSourceId(w.db), id)
  } else {
    w.db.prepare('UPDATE negatives SET last_verified_at = ?, last_result = ? WHERE id = ?').run(Date.now(), rows, id)
  }
}

export function deleteNegative(wsId: string, id: string): void {
  const w = workspaces.get(wsId)
  if (!w) return
  w.db.exec(NEGATIVES_DDL)
  w.db.prepare('DELETE FROM negatives WHERE id = ?').run(id)
}

// ---- Case Report: adjudication ----

// The summation layer. Every claim the case contains — events, leads, proven absences, evidence gaps
// and entity verdicts — read as ONE list the analyst can agree or disagree with.
//
// Adjudication is ORTHOGONAL METADATA, not a copy. A verdict is keyed by (kind, id) against records
// that already exist, because making the agent record a claim AND a finding would double the exact
// "it is in the prose but not in the record" failure this app fights everywhere else. There is one
// source of truth per claim; this table only says what someone decided about it.
//
// Two rules encoded here:
//   • A REJECTION REQUIRES A REASON. An unexplained rejection is precisely the one that cannot feed
//     back to the agent later, which is the whole point of storing it.
//   • REJECTING IS NOT DELETING. A rejected claim plus the analyst's reasoning is the highest-value
//     artifact in the app; deletion is for junk and duplicates, and remains a separate action.
const FINDING_REVIEW_DDL =
  'CREATE TABLE IF NOT EXISTS finding_review (target_kind TEXT NOT NULL, target_id TEXT NOT NULL, verdict TEXT NOT NULL, ' +
  'reason TEXT, actor TEXT, reviewed_at INTEGER, PRIMARY KEY (target_kind, target_id))'

export type ReviewKind = 'event' | 'lead' | 'negative' | 'entity'
export type ReviewVerdict = 'pending' | 'approved' | 'rejected'

export interface CaseReportItem {
  kind: ReviewKind
  id: string
  title: string
  detail: string | null
  /** Host(s) this claim concerns, for grouping the queue. Empty when it isn't host-specific. */
  hosts: string[]
  /** Who asserted it — the agent, or the analyst. */
  actor: 'ai' | 'analyst'
  verdict: ReviewVerdict
  /** Why the analyst rejected it. Always present on a rejection; that is enforced on write. */
  reason: string | null
  reviewedAt: number | null
  /** How much stands behind it — evidence items, grounding rows, sources searched. */
  support: number
  /** Kind-specific flags worth seeing in the queue (stale, overturned, uncollected, …). */
  flags: string[]
}

/**
 * Set (or clear) an analyst verdict on one claim.
 *
 * `pending` clears the row rather than storing a third state, so "never reviewed" and "reviewed then
 * un-reviewed" are the same thing — which is what an analyst means when they undo a verdict.
 */
export function setFindingReview(
  wsId: string,
  kind: ReviewKind,
  id: string,
  verdict: ReviewVerdict,
  reason: string | null,
  actor: 'ai' | 'analyst' = 'analyst'
): { ok: true } | { ok: false; error: string } {
  const w = workspaces.get(wsId)
  if (!w) return { ok: false, error: 'No workspace is open.' }
  w.db.exec(FINDING_REVIEW_DDL)
  const trimmed = reason != null ? String(reason).trim().slice(0, 2000) : ''
  if (verdict === 'rejected' && !trimmed) {
    return { ok: false, error: 'Rejecting a finding requires a reason — an unexplained rejection cannot be fed back or reviewed later.' }
  }
  if (verdict === 'pending') {
    w.db.prepare('DELETE FROM finding_review WHERE target_kind = ? AND target_id = ?').run(kind, id)
    return { ok: true }
  }
  w.db
    .prepare(
      'INSERT INTO finding_review (target_kind, target_id, verdict, reason, actor, reviewed_at) VALUES (?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(target_kind, target_id) DO UPDATE SET verdict = excluded.verdict, reason = excluded.reason, actor = excluded.actor, reviewed_at = excluded.reviewed_at'
    )
    .run(kind, id, verdict, trimmed || null, actor, Date.now())
  return { ok: true }
}

/**
 * The whole case as one adjudicable list.
 *
 * Assembled on read from the stores that already hold the claims. Nothing here is stored twice, so a
 * claim edited anywhere shows its current wording, and a verdict survives that edit.
 */
export function listCaseReport(wsId: string): CaseReportItem[] {
  const w = workspaces.get(wsId)
  if (!w) return []
  w.db.exec(FINDING_REVIEW_DDL)
  const reviews = new Map<string, { verdict: ReviewVerdict; reason: string | null; reviewedAt: number }>()
  for (const r of w.db.prepare('SELECT target_kind, target_id, verdict, reason, reviewed_at FROM finding_review').all() as Array<{
    target_kind: string
    target_id: string
    verdict: string
    reason: string | null
    reviewed_at: number
  }>) {
    reviews.set(`${r.target_kind}|${r.target_id}`, {
      verdict: r.verdict === 'approved' ? 'approved' : r.verdict === 'rejected' ? 'rejected' : 'pending',
      reason: r.reason,
      reviewedAt: r.reviewed_at
    })
  }
  const verdictOf = (kind: ReviewKind, id: string): { verdict: ReviewVerdict; reason: string | null; reviewedAt: number | null } => {
    const hit = reviews.get(`${kind}|${id}`)
    return hit ? { verdict: hit.verdict, reason: hit.reason, reviewedAt: hit.reviewedAt } : { verdict: 'pending', reason: null, reviewedAt: null }
  }

  const out: CaseReportItem[] = []

  for (const e of listEvents(wsId)) {
    out.push({
      kind: 'event',
      id: e.id,
      title: e.label,
      detail: e.uncertainty ? `${e.description ? e.description + ' — ' : ''}UNSETTLED: ${e.uncertainty}` : (e.description ?? null),
      hosts: e.hosts,
      actor: e.actor,
      support: e.evidence.length,
      flags: [
        // A contested reading is where the analyst's judgement is most needed and the agent's is
        // least reliable, so it sorts to the top of the queue rather than blending in.
        ...(e.uncertainty ? ['unsettled'] : []),
        ...(e.technique ? [e.technique] : []),
        // A single-source event in a multi-artifact case is usually under-corroborated — worth
        // surfacing in a review queue, where deciding "is this solid" is the entire task.
        ...(e.evidence.length <= 1 ? ['single-source'] : [])
      ],
      ...verdictOf('event', e.id)
    })
  }

  for (const l of listLeads(wsId)) {
    out.push({
      kind: 'lead',
      id: l.id,
      title: l.statement,
      detail: l.whyUncertain ?? null,
      hosts: [],
      actor: 'ai',
      support: l.grounding.length,
      flags: ['unproven', ...(l.status !== 'open' ? [l.status] : [])],
      ...verdictOf('lead', l.id)
    })
  }

  for (const n of listNegatives(wsId)) {
    const scopeBits: string[] = []
    if (n.kind === 'absence') {
      const pattern = n.scope.value ?? n.scope.search ?? (n.scope.filters ? 'filter' : null)
      scopeBits.push(`searched ${n.scope.sourceIds.length} source(s)`)
      if (pattern) scopeBits.push(`for ${pattern}`)
      if (n.scope.timeFrom != null || n.scope.timeTo != null) scopeBits.push('in a time window')
      scopeBits.push('— 0 rows')
    }
    const negDetail = [n.whyItMatters, scopeBits.length ? scopeBits.join(' ') : null].filter(Boolean).join(' · ') || null
    out.push({
      kind: 'negative',
      id: n.id,
      title: n.statement,
      detail: negDetail,
      hosts: n.scope.hosts ?? [],
      actor: n.actor,
      support: n.scope.sourceIds.length,
      flags: [
        n.kind === 'gap' ? 'evidence-gap' : 'absence',
        // A stale or overturned absence must never read as settled in the summation — that is
        // exactly how a "this host was clean" conclusion goes wrong.
        ...(n.stale ? ['stale'] : []),
        ...((n.lastResult ?? 0) > 0 ? ['overturned'] : [])
      ],
      ...verdictOf('negative', n.id)
    })
  }

  // Only JUDGED entities are claims. An entity that merely exists in the derived spine is data, not
  // an assertion, and putting every host in the review queue would bury the ones someone ruled on.
  for (const en of listEntities(wsId)) {
    const uncollected = en.kind === 'system' && !en.collected
    if (en.status === 'unknown' && !uncollected) continue
    out.push({
      kind: 'entity',
      id: en.id,
      title: `${en.kind === 'system' ? 'System' : 'Account'} ${en.name} — ${en.status}`,
      detail: en.notes ?? null,
      hosts: en.kind === 'system' ? [en.name] : [],
      actor: en.actor ?? 'ai',
      support: en.eventCount,
      flags: [en.status, ...(uncollected ? ['not-collected'] : []), ...(en.origin === 'asserted' ? ['asserted'] : [])],
      ...verdictOf('entity', en.id)
    })
  }

  // Unsettled and overturned claims first — the queue should open on what needs a human, not on
  // whatever happened to be recorded earliest.
  const rank = (i: CaseReportItem): number =>
    i.flags.includes('overturned') ? 0 : i.flags.includes('unsettled') ? 1 : i.flags.includes('stale') ? 2 : i.flags.includes('single-source') ? 3 : 4
  return out.sort((a, b) => rank(a) - rank(b))
}

// ---- IOC catalog ----

export interface IocRecord {
  id: string
  value: string
  type: string
  context: string | null
}

/** Upsert an IOC into the catalog (workspace-level). Does not touch the Intel grid. */
export function recordIoc(wsId: string, ioc: IocRecord): void {
  const w = workspaces.get(wsId)
  if (!w) return
  w.db.exec(IOCS_DDL)
  w.db
    .prepare(
      'INSERT INTO iocs (id, value, type, context, created_at) VALUES (?, ?, ?, ?, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET value = excluded.value, type = excluded.type, context = COALESCE(excluded.context, iocs.context)'
    )
    .run(ioc.id, ioc.value, ioc.type, ioc.context, Date.now())
}

export function listIocs(wsId: string): Array<IocRecord & { createdAt: number }> {
  const w = workspaces.get(wsId)
  if (!w) return []
  w.db.exec(IOCS_DDL)
  const rows = w.db.prepare('SELECT id, value, type, context, created_at FROM iocs ORDER BY type, value').all() as Array<{
    id: string
    value: string
    type: string
    context: string | null
    created_at: number
  }>
  return rows.map((r) => ({ id: r.id, value: r.value, type: r.type, context: r.context, createdAt: r.created_at }))
}

export function deleteIoc(wsId: string, id: string): void {
  const w = workspaces.get(wsId)
  if (!w) return
  w.db.prepare('DELETE FROM iocs WHERE id = ?').run(id)
}

export function clearIocs(wsId: string): void {
  const w = workspaces.get(wsId)
  if (!w) return
  w.db.exec(IOCS_DDL)
  w.db.exec('DELETE FROM iocs')
}

// ---- AI triage coverage (persistent, per workspace) -------------------------------------------

/** Record that the AI examined these sources (idempotent). Survives session/Continue boundaries. */
export function markCoverage(wsId: string, sourceIds: number[]): void {
  const w = workspaces.get(wsId)
  if (!w || !Array.isArray(sourceIds)) return
  w.db.exec(AI_COVERAGE_DDL)
  const stmt = w.db.prepare('INSERT OR IGNORE INTO ai_coverage (source_id, examined_at) VALUES (?, ?)')
  const now = Date.now()
  const tx = w.db.transaction((ids: number[]) => {
    for (const id of ids) if (Number.isInteger(id)) stmt.run(id, now)
  })
  tx(sourceIds)
}

/** The source ids the AI has examined so far in this workspace. */
export function listCoverage(wsId: string): number[] {
  const w = workspaces.get(wsId)
  if (!w) return []
  w.db.exec(AI_COVERAGE_DDL)
  return (w.db.prepare('SELECT source_id FROM ai_coverage').all() as Array<{ source_id: number }>).map((r) => r.source_id)
}

// ---- AI investigation state: plan + progress notes (persistent, per workspace) ----------------
// Stored in the existing ws_meta key/value table (keys ai_plan / ai_notes / ai_state_updated). This
// is the investigation's living plan + where-I-was, so a timeout/restart resumes cleanly. Both the
// agent (update_plan / save_progress) and the analyst (UI) read and write it.

export type PlanStatus = 'pending' | 'active' | 'done'
export interface PlanStep {
  text: string
  status: PlanStatus
}
export interface InvestigationState {
  plan: PlanStep[]
  notes: string
  updatedAt: number | null
}

function normPlanStatus(v: unknown): PlanStatus {
  const s = String(v ?? '').trim().toLowerCase()
  return s === 'done' || s === 'active' ? s : 'pending'
}
function ensureWsMeta(w: { db: Database.Database }): void {
  w.db.exec('CREATE TABLE IF NOT EXISTS ws_meta (key TEXT PRIMARY KEY, value TEXT)')
}
function wsMetaGet(w: { db: Database.Database }, key: string): string | null {
  return (w.db.prepare('SELECT value FROM ws_meta WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null
}
function wsMetaSet(w: { db: Database.Database }, key: string, value: string): void {
  w.db.prepare('INSERT OR REPLACE INTO ws_meta (key, value) VALUES (?, ?)').run(key, value)
}

/** Read the investigation plan + progress notes for a workspace. */
export function getInvestigation(wsId: string): InvestigationState {
  const w = workspaces.get(wsId)
  if (!w) return { plan: [], notes: '', updatedAt: null }
  ensureWsMeta(w)
  let plan: PlanStep[] = []
  try {
    const raw = wsMetaGet(w, 'ai_plan')
    const parsed = raw ? JSON.parse(raw) : []
    if (Array.isArray(parsed)) plan = parsed.map((s) => ({ text: String(s?.text ?? ''), status: normPlanStatus(s?.status) })).filter((s) => s.text)
  } catch {
    plan = []
  }
  const ua = wsMetaGet(w, 'ai_state_updated')
  return { plan, notes: wsMetaGet(w, 'ai_notes') ?? '', updatedAt: ua ? Number(ua) : null }
}

/** Replace the investigation plan (the full ordered step list). */
export function setInvestigationPlan(wsId: string, plan: PlanStep[]): void {
  const w = workspaces.get(wsId)
  if (!w) return
  ensureWsMeta(w)
  const clean = (Array.isArray(plan) ? plan : [])
    .slice(0, 100)
    .map((s) => ({ text: String(s?.text ?? '').slice(0, 500), status: normPlanStatus(s?.status) }))
    .filter((s) => s.text)
  wsMetaSet(w, 'ai_plan', JSON.stringify(clean))
  wsMetaSet(w, 'ai_state_updated', String(Date.now()))
}

/** Replace the investigation progress notes (where the analyst/agent is now). */
export function setInvestigationNotes(wsId: string, notes: string): void {
  const w = workspaces.get(wsId)
  if (!w) return
  ensureWsMeta(w)
  wsMetaSet(w, 'ai_notes', String(notes ?? '').slice(0, 5000))
  wsMetaSet(w, 'ai_state_updated', String(Date.now()))
}

/**
 * Per-tag counts for the active source under the current filters + search (the tag filter itself is
 * excluded — see buildTagCountsSql). Drives the sidebar rollup so it reflects the filtered view
 * rather than the whole source. Empty for the legacy single-file table (no tags).
 */
export function getTagCounts(
  tabId: string,
  filters?: Filter[],
  search?: string
): Array<{ tag: string; cnt: number }> {
  const e = get(tabId)
  const q = buildTagCountsSql(e.meta.columns, filters, search, e.table)
  if (!q) return []
  return e.db.prepare(q.sql).all(...q.params) as Array<{ tag: string; cnt: number }>
}

/**
 * Sweep a source's rows for an intel set, recording each row that contains a known indicator as a
 * "sighting" in intel_hits. Scans the chosen columns (or all when none given) in rowid chunks so it
 * yields between slices — responsive, cancelable, progress-reporting — and replaces any prior
 * sightings for the source. Cost scales with rows × intel-set size (the JS match per cell), so it's
 * a background op like distinct/count. Returns the sighting (distinct hit-row) + total-hit counts,
 * or null if canceled mid-scan.
 */
// Rows per sweep scan slice — smaller than FILT_CHUNK so progress + cancel are fine-grained.
const SWEEP_SCAN_CHUNK = 50_000

export async function intelSweep(
  tabId: string,
  entries: IntelEntry[],
  columns: string[] | undefined,
  mode: 'replace' | 'add',
  onPartial: (sightings: number, scanned: number, max: number) => void,
  shouldAbort: () => boolean
): Promise<{ sightings: number; hits: number } | null> {
  const e = get(tabId)
  const m = /^data_(\d+)$/.exec(e.table)
  if (!m) return { sightings: 0, hits: 0 } // legacy single-file table: no workspace/sightings
  const sid = Number(m[1])
  const intel = compileIntel(entries)
  const scanCols = columns && columns.length > 0 ? columns : e.meta.columns.map((c) => c.name)
  e.db.exec(INTEL_HITS_DDL) // ensure (older workspaces / first sweep)
  // 'replace' wipes prior sightings; 'add' keeps them (INSERT OR IGNORE makes re-hits idempotent).
  if (mode !== 'add') e.db.prepare('DELETE FROM intel_hits WHERE source_id = ?').run(sid)
  const ins = e.db.prepare(
    'INSERT OR IGNORE INTO intel_hits (source_id, rid, indicator, kind, hitset) VALUES (?, ?, ?, ?, ?)'
  )
  const max = e.meta.rowCount
  const sightingRids = new Set<number>()
  let hits = 0
  // Smaller than the filter-index chunk: the sweep reports progress + checks for cancel between
  // chunks, so a finer slice gives a smooth percent (not one jump per million rows) and a snappier
  // Cancel, at the cost of a few more bounded range scans. Also caps the per-slice memory.
  for (let lo = 0; lo < max; lo += SWEEP_SCAN_CHUNK) {
    if (shouldAbort()) return null
    const hi = Math.min(lo + SWEEP_SCAN_CHUNK, max)
    const q = buildSweepScanSql(scanCols, lo, hi, e.table)
    const slice = e.db.prepare(q.sql).raw(true).all(...q.params) as unknown[][]
    const writeChunk = e.db.transaction((rows: unknown[][]) => {
      for (const row of rows) {
        const rid = row[0] as number
        // row[1..] are the scanned columns; join them so one matchText covers the whole row.
        let text = ''
        for (let i = 1; i < row.length; i++) if (row[i] != null) text += String(row[i]) + '\n'
        const found = matchText(text, intel)
        if (found.length === 0) continue
        sightingRids.add(rid)
        for (const f of found) hits += ins.run(sid, rid, f.value, f.kind, 'pasted').changes
      }
    })
    writeChunk(slice)
    onPartial(sightingRids.size, hi, max)
    await new Promise((resolve) => setImmediate(resolve)) // yield between chunks
  }
  e.filt = undefined // a "show only sightings" filter's match set just changed
  return { sightings: sightingRids.size, hits }
}

/** Every sighting in a source as (rid, indicator, kind) — the renderer maps these to row markers. */
export function listSightings(wsId: string, sourceId: number): Array<{ rid: number; indicator: string; kind: string }> {
  const w = workspaces.get(wsId)
  if (!w || !Number.isInteger(sourceId)) return []
  w.db.exec(INTEL_HITS_DDL)
  return w.db
    .prepare('SELECT rid, indicator, kind FROM intel_hits WHERE source_id = ? ORDER BY rid')
    .all(sourceId) as Array<{ rid: number; indicator: string; kind: string }>
}

/** Per-indicator sighting rollup: each matched indicator + kind and how many distinct rows it hit.
 *  Drives the Sightings panel (the aggregate + "zero in" facet). */
export function sightingSummary(
  wsId: string,
  sourceId: number
): Array<{ indicator: string; kind: string; count: number }> {
  const w = workspaces.get(wsId)
  if (!w || !Number.isInteger(sourceId)) return []
  w.db.exec(INTEL_HITS_DDL)
  return w.db
    .prepare(
      'SELECT indicator, kind, COUNT(DISTINCT rid) AS count FROM intel_hits WHERE source_id = ? ' +
        'GROUP BY indicator, kind ORDER BY count DESC, indicator'
    )
    .all(sourceId) as Array<{ indicator: string; kind: string; count: number }>
}

/** Workspace-wide sighting rollup grouped by indicator → the files it was seen in (each with its
 *  match count + the matching rids, so the UI can jump straight to those rows). Powers the cross-file
 *  Sightings results view — "which of my 12 files does 192.168.1.5 actually appear in?". */
export function sightingsByIndicator(
  wsId: string
): Array<{
  indicator: string
  kind: string
  /** Distinct matching rows summed across files (rids aren't unique across sources, so this is a sum). */
  total: number
  sources: Array<{ sourceId: number; sourceName: string; count: number; rids: number[] }>
}> {
  const w = workspaces.get(wsId)
  if (!w) return []
  w.db.exec(INTEL_HITS_DDL)
  // intel_hits PK is (source_id, rid, indicator), so (source, indicator, rid) rows are already distinct;
  // ordering lets us group in a single pass.
  const rows = w.db
    .prepare(
      'SELECT h.indicator AS indicator, h.kind AS kind, h.source_id AS sourceId, ' +
        "COALESCE(s.name, 'source ' || h.source_id) AS sourceName, h.rid AS rid " +
        'FROM intel_hits h LEFT JOIN sources s ON s.id = h.source_id ' +
        'ORDER BY h.indicator, h.source_id, h.rid'
    )
    .all() as Array<{ indicator: string; kind: string; sourceId: number; sourceName: string; rid: number }>
  const byInd = new Map<string, { indicator: string; kind: string; sources: Map<number, { sourceId: number; sourceName: string; rids: number[] }> }>()
  for (const r of rows) {
    const key = `${r.kind}:${r.indicator}`
    let g = byInd.get(key)
    if (!g) {
      g = { indicator: r.indicator, kind: r.kind, sources: new Map() }
      byInd.set(key, g)
    }
    let src = g.sources.get(r.sourceId)
    if (!src) {
      src = { sourceId: r.sourceId, sourceName: r.sourceName, rids: [] }
      g.sources.set(r.sourceId, src)
    }
    src.rids.push(r.rid)
  }
  return [...byInd.values()]
    .map((g) => {
      const sources = [...g.sources.values()]
        .map((s) => ({ sourceId: s.sourceId, sourceName: s.sourceName, count: s.rids.length, rids: s.rids }))
        .sort((a, b) => b.count - a.count || a.sourceName.localeCompare(b.sourceName))
      return { indicator: g.indicator, kind: g.kind, total: sources.reduce((n, s) => n + s.count, 0), sources }
    })
    .sort((a, b) => b.total - a.total || a.indicator.localeCompare(b.indicator))
}

/** Clear sightings for a source: all of them, or just one indicator's, or just one row's. */
export function clearSightings(wsId: string, sourceId: number, opts?: { indicator?: string; rid?: number }): void {
  const w = workspaces.get(wsId)
  if (!w || !Number.isInteger(sourceId)) return
  if (opts?.indicator != null) {
    w.db.prepare('DELETE FROM intel_hits WHERE source_id = ? AND indicator = ?').run(sourceId, opts.indicator)
  } else if (opts?.rid != null) {
    w.db.prepare('DELETE FROM intel_hits WHERE source_id = ? AND rid = ?').run(sourceId, opts.rid)
  } else {
    w.db.prepare('DELETE FROM intel_hits WHERE source_id = ?').run(sourceId)
  }
  const e = tables.get(sourceKey(wsId, sourceId))
  if (e) e.filt = undefined
}

export function closeWorkspace(wsId: string): void {
  const w = workspaces.get(wsId)
  if (!w) return
  for (const key of [...tables.keys()]) if (key.startsWith(`${wsId}:`)) tables.delete(key)
  try {
    w.db.close()
  } catch {
    /* ignore */
  }
  workspaces.delete(wsId)
}

/** Delete a workspace's db files (Home "delete workspace"). */
export function deleteWorkspace(dbPath: string): void {
  for (const [wsId, w] of workspaces) if (w.dbPath === dbPath) closeWorkspace(wsId)
  removeDbFiles(dbPath)
}

const SCHEMA_VERSION = 1

/** Write pl_meta + pl_columns so the db carries its own column metadata (self-describing). */
function writeSelfDescribingTables(
  db: Database.Database,
  sourceName: string,
  columns: ColumnMap[],
  rowCount: number
): void {
  db.exec('CREATE TABLE IF NOT EXISTS pl_meta (key TEXT PRIMARY KEY, value TEXT)')
  const setMeta = db.prepare('INSERT OR REPLACE INTO pl_meta (key, value) VALUES (?, ?)')
  setMeta.run('source_name', sourceName)
  setMeta.run('row_count', String(rowCount))
  setMeta.run('num_cols', String(columns.length))
  setMeta.run('version', String(SCHEMA_VERSION))
  setMeta.run('created_at', String(Date.now()))
  db.exec('CREATE TABLE IF NOT EXISTS pl_columns (idx INTEGER PRIMARY KEY, name TEXT, original TEXT, time TEXT)')
  const setCol = db.prepare('INSERT OR REPLACE INTO pl_columns (idx, name, original, time) VALUES (?, ?, ?, ?)')
  db.transaction(() => columns.forEach((c, i) => setCol.run(i, c.name, c.original, c.time ?? null)))()
}

/**
 * Open an existing persistent db by path and register it under tabId — no re-ingest. Used to
 * resume a session on restart and to "Open Database…" a .db directly. Reads the self-describing
 * tables; throws if they're absent (not a pink-lemonade database).
 */
export function openDb(tabId: string, dbPath: string): CsvTableMeta {
  closeTab(tabId)
  if (!existsSync(dbPath)) throw new Error('Database file not found')
  const db = new Database(dbPath)
  let metaRows: Array<{ key: string; value: string }>
  let colRows: Array<{ name: string; original: string; time: string | null }>
  try {
    metaRows = db.prepare('SELECT key, value FROM pl_meta').all() as typeof metaRows
    colRows = db.prepare('SELECT name, original, time FROM pl_columns ORDER BY idx').all() as typeof colRows
  } catch {
    db.close()
    throw new Error('Not a pink-lemonade database')
  }
  applyQueryPragmas(db)
  const m = Object.fromEntries(metaRows.map((r) => [r.key, r.value]))
  const columns: ColumnMap[] = colRows.map((r) =>
    r.time ? { name: r.name, original: r.original, time: r.time as TimeKind } : { name: r.name, original: r.original }
  )
  const meta: CsvTableMeta = {
    tabId,
    dbPath,
    sourceName: m.source_name ?? basename(dbPath),
    columns,
    rowCount: Number(m.row_count ?? 0)
  }
  tables.set(tabId, { db, meta, indexes: new Set(), table: 'data', filtTable: FILT_TABLE, ownsDb: true })
  return meta
}

/** Close any open connection to a session db and delete its files (Home "delete session"). */
export function deleteDb(dbPath: string): void {
  for (const [id, e] of tables) {
    if (e.meta.dbPath === dbPath) closeTab(id)
  }
  removeDbFiles(dbPath)
}

/** Stable token identifying a predicate, so the page query and the materialized index agree. */
function filterToken(filters: Filter[] | undefined, search: string | undefined): string {
  return JSON.stringify({ f: filters ?? [], s: search ?? '' })
}

function hasPredicate(opts: QueryOpts): boolean {
  return (opts.filters != null && opts.filters.length > 0) || (opts.search != null && opts.search !== '')
}

/**
 * 0-based ordinal of a row (by rowid) within an unsorted filtered/searched view — so the grid can
 * scroll to/center it after a time pivot ("keep your spot"). Uses the materialized filter index
 * (rids in rowid = display order), so it's O(1)-ish and free once the count built the index. Returns
 * -1 if the index isn't current for this predicate (caller waits for the count) or the row isn't in it.
 */
export function locateRow(
  tabId: string,
  rid: number,
  filters: Filter[] | undefined,
  search: string | undefined
): number {
  const e = tables.get(tabId)
  if (!e || !Number.isInteger(rid)) return -1
  if (!e.filt || !e.filt.complete || e.filt.token !== filterToken(filters, search)) return -1
  try {
    const row = e.db.prepare(`SELECT rowid AS pos FROM ${e.filtTable} WHERE rid = ?`).get(rid) as
      | { pos: number }
      | undefined
    return row ? row.pos - 1 : -1
  } catch {
    return -1
  }
}

/** One file's hits for a workspace-wide free-string search (see findInFiles). */
export interface FindInFilesHit {
  sourceId: number
  name: string
  group: string | null
  rowCount: number
  /** Exact number of rows in this source containing the term (full count, not capped). */
  matchCount: number
  /** Matching rowids for the click-to-jump pivot, capped at `ridCap` (capped === matchCount > rids.length). */
  rids: number[]
  capped: boolean
}

/**
 * Workspace-wide "find in files": a CONTAINS (substring, case-insensitive) search for one arbitrary
 * string across every source's data table (optionally scoped to one group), the user-facing twin of
 * the AI's find_in_all_sources. Runs in the worker over the already-registered source tables, so it
 * never blocks the UI and needs no per-source open. Returns one row per source WITH a hit, sorted by
 * match count desc — each carries the matching rowids so the panel can jump to those exact rows.
 * `group`: undefined = all sources; null = only ungrouped; a string = only that group label.
 */
export function findInFiles(
  wsId: string,
  term: string,
  opts?: { group?: string | null; ridCap?: number }
): FindInFilesHit[] {
  const w = workspaces.get(wsId)
  const t = (term ?? '').trim()
  if (!w || t === '') return []
  const ridCap = Math.min(Math.max(Math.trunc(opts?.ridCap ?? 2000), 1), 20000)
  ensureSourceGroupColumn(w.db)
  const srcRows = w.db.prepare('SELECT id, name, row_count, group_label FROM sources ORDER BY id').all() as Array<{
    id: number
    name: string
    row_count: number
    group_label: string | null
  }>
  const wantGroup = opts && 'group' in opts ? opts.group : undefined // undefined = every source
  const out: FindInFilesHit[] = []
  for (const s of srcRows) {
    const group = s.group_label ?? null
    if (wantGroup !== undefined && group !== wantGroup) continue
    const tabId = sourceKey(wsId, s.id)
    const e = tables.get(tabId)
    if (!e) continue // every source is registered on open; skip defensively if not
    const cnt = buildCountSql(e.meta.columns, undefined, t, e.table)
    const matchCount = (e.db.prepare(cnt.sql).get(...(cnt.params as never[])) as { n: number }).n
    if (matchCount === 0) continue
    const { rids } = queryRows(tabId, { search: t, limit: ridCap, offset: 0 } as QueryOpts)
    out.push({ sourceId: s.id, name: s.name, group, rowCount: s.row_count, matchCount, rids, capped: matchCount > rids.length })
  }
  out.sort((a, b) => b.matchCount - a.matchCount || a.name.localeCompare(b.name))
  return out
}

/** Content-based IOC↔event linkage: which events' evidence ROWS actually contain each IOC value. */
export interface IocEventLink {
  iocId: string
  eventIds: string[]
}

/**
 * For every catalogued IOC, find which events have at least one EVIDENCE ROW whose cell content
 * actually contains the IOC's value (case-insensitive substring) — a true content association, not a
 * guess from the event's label/matched text. Reads the real rows behind each event's evidence (the
 * capped rid set per evidence item) from the source data tables. The renderer unions this with its
 * label/description text match to draw the constellation's IOC→event edges. Worker-side (row content
 * isn't in the renderer); one row-text fetch per (source) regardless of IOC count.
 */
export function iocEventLinks(wsId: string): IocEventLink[] {
  const w = workspaces.get(wsId)
  if (!w) return []
  const MIN = 3 // skip too-short values (trivial substrings); mirrors the renderer's guard
  const iocs = (w.db.prepare('SELECT id, value FROM iocs').all() as Array<{ id: string; value: string }>)
    .map((i) => ({ id: i.id, v: i.value.trim().toLowerCase() }))
    .filter((i) => i.v.length >= MIN)
  if (iocs.length === 0) return []

  const evidence = w.db.prepare('SELECT event_id, source_id, rids FROM event_evidence').all() as Array<{
    event_id: string
    source_id: number
    rids: string | null
  }>
  // Group evidence items by source so we fetch each source's rows once.
  const bySource = new Map<number, Array<{ eventId: string; rids: number[] }>>()
  for (const ev of evidence) {
    let rids: number[] = []
    try {
      const parsed = JSON.parse(ev.rids ?? '[]')
      if (Array.isArray(parsed)) rids = parsed.filter((n) => Number.isInteger(n))
    } catch {
      /* malformed rids → skip this evidence item */
    }
    if (rids.length === 0) continue
    const arr = bySource.get(ev.source_id) ?? []
    arr.push({ eventId: ev.event_id, rids })
    bySource.set(ev.source_id, arr)
  }

  const evOrder = new Map((w.db.prepare('SELECT id FROM events').all() as Array<{ id: string }>).map((e, i) => [e.id, i]))
  const linkSets = new Map<string, Set<string>>() // iocId → eventIds

  for (const [sourceId, items] of bySource) {
    const e = tables.get(sourceKey(wsId, sourceId))
    if (!e) continue
    const selCols = e.meta.columns.map((c) => c.name)
    if (selCols.length === 0) continue
    const allRids = [...new Set(items.flatMap((it) => it.rids))]

    // rid → which IOC ids its row content contains (computed once per source).
    const ridHits = new Map<number, Set<string>>()
    const CHUNK = 800 // stay under SQLite's bound-parameter limit
    for (let off = 0; off < allRids.length; off += CHUNK) {
      const chunk = allRids.slice(off, off + CHUNK)
      const ph = chunk.map(() => '?').join(',')
      const rows = e.db
        .prepare(`SELECT rowid AS r, ${selCols.join(', ')} FROM ${e.table} WHERE rowid IN (${ph})`)
        .raw(true)
        .all(...chunk) as unknown[][]
      for (const row of rows) {
        const rid = row[0] as number
        const text = row.slice(1).map((v) => (v == null ? '' : String(v))).join('').toLowerCase()
        let hits: Set<string> | undefined
        for (const ioc of iocs) {
          if (text.includes(ioc.v)) (hits ??= new Set()).add(ioc.id)
        }
        if (hits) ridHits.set(rid, hits)
      }
    }
    // An event links to an IOC if any rid of one of its evidence items in this source hit that IOC.
    for (const it of items) {
      for (const rid of it.rids) {
        const hits = ridHits.get(rid)
        if (!hits) continue
        for (const iocId of hits) {
          let s = linkSets.get(iocId)
          if (!s) linkSets.set(iocId, (s = new Set()))
          s.add(it.eventId)
        }
      }
    }
  }

  const out: IocEventLink[] = []
  for (const [iocId, set] of linkSets) {
    out.push({ iocId, eventIds: [...set].sort((a, b) => (evOrder.get(a) ?? 0) - (evOrder.get(b) ?? 0)) })
  }
  return out
}

export function queryRows(tabId: string, opts: QueryOpts): { rows: string[][]; rids: number[] } {
  const e = get(tabId)
  // Fast path for a no-sort filtered/searched view: page the materialized filter index by keyset
  // (O(1) anywhere in the result set) instead of re-scanning the predicate with OFFSET. Used only
  // when the index holds exactly this predicate; otherwise fall back (correct, just slower).
  const q =
    !opts.sort && hasPredicate(opts) && e.filt?.token === filterToken(opts.filters, opts.search)
      ? buildFiltPageSql(e.meta.columns, opts.offset, opts.limit, e.table, e.filtTable, true)
      : buildQueryRowsSql(e.meta.columns, opts, e.table, true)
  // Each row arrives as [rowid, c0, c1, …]; split the leading rowid off so the cell array the grid
  // sees is exactly c0..cN (unchanged shape) while `rids` carries the row identity for tags/scroll.
  const raw = e.db.prepare(q.sql).raw(true).all(...q.params) as unknown[][]
  const rows: string[][] = new Array(raw.length)
  const rids: number[] = new Array(raw.length)
  for (let i = 0; i < raw.length; i++) {
    rids[i] = raw[i][0] as number
    rows[i] = raw[i].slice(1) as string[]
  }
  return { rows, rids }
}

/**
 * Write every row matching the predicate (current filters + search + sort) to `outPath` as CSV,
 * header = the original column names. Streams via `.iterate()` + a buffered fd so a multi-million-
 * row export never materializes in memory. Runs in the DB worker, so a big export doesn't block the
 * UI. Returns the number of data rows written.
 */
export function exportRows(
  tabId: string,
  opts: { filters?: Filter[]; search?: string; sort?: Sort; columns?: string[] },
  outPath: string
): { rows: number } {
  const e = get(tabId)
  // A big sorted export benefits from the same on-demand column index the grid uses.
  if (opts.sort) ensureSortIndex(tabId, opts.sort.col, !!opts.sort.numeric)
  // Honor the grid's visible columns (in their display order) when a subset is given; an
  // empty/absent list exports every column in original order. Unknown names are dropped.
  const byName = new Map(e.meta.columns.map((c) => [c.name, c]))
  const picked = opts.columns?.length
    ? opts.columns.flatMap((n) => {
        const c = byName.get(n)
        return c ? [c] : []
      })
    : e.meta.columns
  const cols = picked.length > 0 ? picked : e.meta.columns
  const q = buildExportSql(cols, opts, e.table)
  const stmt = e.db.prepare(q.sql).raw(true)
  const fd = openSync(outPath, 'w')
  try {
    let buf = csvRow(cols.map((c) => c.original)) + '\n'
    let n = 0
    for (const row of stmt.iterate(...q.params) as Iterable<unknown[]>) {
      buf += csvRow(row.map((v) => (v == null ? '' : String(v)))) + '\n'
      n++
      if (buf.length >= 1 << 20) {
        writeSync(fd, buf)
        buf = ''
      }
    }
    if (buf) writeSync(fd, buf)
    return { rows: n }
  } finally {
    closeSync(fd)
  }
}

// Below this many rows an unindexed sort is already fast enough that an index isn't worth building.
const INDEX_MIN_ROWS = 200_000

/**
 * Build (once, on demand) a column index matching a sort's ORDER BY expression, so sorting a large
 * table uses the index instead of re-sorting the whole set on every window fetch. Without this,
 * a deep sorted scroll is catastrophic (~90s to page the middle of a 12M-row sort); with it,
 * paging is ~100ms. The build is blocking but one-time per (column, numeric/text) per session.
 */
export function ensureSortIndex(tabId: string, col: string, numeric: boolean): void {
  if (!/^c\d+$/.test(col)) throw new Error(`bad column: ${col}`) // SQL-injection boundary
  const e = get(tabId)
  if (e.meta.rowCount < INDEX_MIN_ROWS) return // small table: unindexed sort is already fast
  const key = `${col}:${numeric ? 'n' : 't'}`
  if (e.indexes.has(key)) return
  const expr = numeric ? `CAST(${col} AS REAL)` : `${col} COLLATE NOCASE`
  // Index name includes the table so sources in one workspace db don't collide.
  e.db.exec(`CREATE INDEX IF NOT EXISTS ix_${e.table}_${col}_${numeric ? 'n' : 't'} ON ${e.table} (${expr})`)
  e.indexes.add(key)
}

const FILT_CHUNK = 1_000_000

/**
 * Materialize a filtered/searched view's matching rowids into the tab's _pl_filt index, in rowid
 * chunks, yielding to the event loop between each (so the main process stays responsive and the
 * build can be aborted mid-flight when a newer predicate supersedes it). `onPartial` reports the
 * running match count after each chunk — the count is a free byproduct, and the index then powers
 * O(1) keyset paging of the filtered set. Returns the final count, or null if aborted.
 */
export async function buildFilterIndex(
  tabId: string,
  filters: Filter[] | undefined,
  search: string,
  onPartial: (count: number, scanned: number, max: number) => void,
  shouldAbort: () => boolean
): Promise<number | null> {
  const e = get(tabId)
  const token = filterToken(filters, search || undefined)
  const max = e.meta.rowCount
  // Already built for this exact predicate — reuse it (no rescan).
  if (e.filt?.token === token && e.filt.complete) {
    onPartial(e.filt.count, max, max)
    return e.filt.count
  }
  e.db.exec(`DROP TABLE IF EXISTS ${e.filtTable}`)
  e.db.exec(`CREATE TABLE ${e.filtTable} (rid INTEGER)`)
  e.filt = { token, count: 0, complete: false }
  let total = 0
  for (let lo = 0; lo < max; lo += FILT_CHUNK) {
    if (shouldAbort()) return null
    const hi = Math.min(lo + FILT_CHUNK, max)
    const q = buildFilterInsertChunkSql(e.meta.columns, filters, search || undefined, lo, hi, e.table, e.filtTable)
    total += e.db.prepare(q.sql).run(...q.params).changes
    e.filt.count = total
    onPartial(total, hi, max)
    await new Promise((resolve) => setImmediate(resolve)) // yield between chunks
  }
  e.filt.complete = true
  return total
}

interface DistinctResult {
  rows: Array<{ val: string; cnt: number }>
  total: number
  truncated: boolean
}

/**
 * Distinct values + counts computed in rowid chunks (one GROUP BY per slice, merged in JS) so the
 * scan yields between slices — responsive, cancelable, and progress-reporting — instead of one
 * blocking GROUP BY. Returns the top-`limit` by count plus the true distinct total (capped at
 * DISTINCT_CAP for pathological high-cardinality columns), or null if canceled mid-scan.
 */
export async function getColumnDistinctChunked(
  tabId: string,
  col: string,
  filters: Filter[] | undefined,
  limit: number,
  onPartial: (count: number, scanned: number, max: number) => void,
  shouldAbort: () => boolean
): Promise<DistinctResult | null> {
  const e = get(tabId)
  const max = e.meta.rowCount
  const counts = new Map<string, number>()
  let capped = false
  for (let lo = 0; lo < max; lo += FILT_CHUNK) {
    if (shouldAbort()) return null
    const hi = Math.min(lo + FILT_CHUNK, max)
    const q = buildDistinctChunkSql(col, filters, lo, hi, e.table)
    const slice = e.db.prepare(q.sql).all(...q.params) as Array<{ val: string | null; cnt: number }>
    for (const r of slice) {
      const v = r.val == null ? '' : String(r.val)
      const cur = counts.get(v)
      if (cur === undefined) {
        if (counts.size >= DISTINCT_CAP) {
          capped = true
          continue
        }
        counts.set(v, r.cnt)
      } else {
        counts.set(v, cur + r.cnt)
      }
    }
    onPartial(counts.size, hi, max)
    await new Promise((resolve) => setImmediate(resolve)) // yield between chunks
  }
  // top-`limit` by count desc, then value asc — same order buildDistinctSql produced.
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const rows = entries.slice(0, Math.max(0, limit)).map(([val, cnt]) => ({ val, cnt }))
  return { rows, total: counts.size, truncated: capped || entries.length > rows.length }
}

export interface AggregateOpts {
  col: string
  by?: string
  bucket?: TimeBucket
  filters?: Filter[]
  search?: string
  limit: number
  order: 'count' | 'value'
}

/** GROUP BY … COUNT over a column (optionally time-bucketed and/or cross-tabbed against `by`), with
 *  the same filter/search grammar as the row query. One query for a whole distribution/histogram. */
export function aggregate(
  tabId: string,
  opts: AggregateOpts
): { groups: Array<{ value: string; by?: string; count: number }>; returned: number; totalBuckets: number; truncated: boolean } {
  const e = get(tabId)
  const kindOf = (c: string): TimeKind | null => (e.meta.columns.find((m) => m.name === c)?.time as TimeKind | undefined) ?? null
  const limit = Math.max(1, opts.limit)
  const q = buildAggregateSql(
    e.meta.columns,
    {
      col: opts.col,
      colKind: kindOf(opts.col),
      by: opts.by,
      byKind: opts.by ? kindOf(opts.by) : null,
      bucket: opts.bucket,
      filters: opts.filters,
      search: opts.search,
      limit: limit + 1, // pull one extra row to detect truncation
      order: opts.order
    },
    e.table
  )
  const rows = e.db.prepare(q.sql).all(...q.params) as Array<{ gv: string | null; bv?: string | null; n: number }>
  const truncated = rows.length > limit
  const groups = rows.slice(0, limit).map((r) => ({
    value: r.gv == null ? '' : String(r.gv),
    ...(opts.by ? { by: r.bv == null ? '' : String(r.bv) } : {}),
    count: r.n
  }))
  // Total distinct buckets (ignoring the limit) so a truncated result reads "20 of 67", not just
  // "truncated" — the caller can tell whether it saw nearly everything or a small slice. Only worth
  // the extra query when the limit actually bit.
  let totalBuckets = groups.length
  if (truncated) {
    const cq = buildAggregateCountSql(
      e.meta.columns,
      { col: opts.col, colKind: kindOf(opts.col), by: opts.by, byKind: opts.by ? kindOf(opts.by) : null, bucket: opts.bucket, filters: opts.filters, search: opts.search },
      e.table
    )
    totalBuckets = (e.db.prepare(cq.sql).get(...cq.params) as { n: number }).n
  }
  return { groups, returned: groups.length, totalBuckets, truncated }
}

export function getColumnLongest(tabId: string, col: string): string {
  const e = get(tabId)
  const q = buildLongestSql(col, 256, e.table)
  const r = e.db.prepare(q.sql).get(...q.params) as { val: string | null } | undefined
  return r?.val ?? ''
}

export function getColumnValues(tabId: string, col: string, filters?: Filter[]): string[] {
  const e = get(tabId)
  const q = buildColumnValuesSql(col, filters, undefined, e.table)
  const rows = e.db.prepare(q.sql).raw(true).all(...q.params) as unknown[][]
  return rows.map((r) => String(r[0] ?? ''))
}

export function getColumnStats(tabId: string, col: string): CsvColumnStats {
  const e = get(tabId)
  const q = buildStatsSql(col, e.table)
  const r = e.db.prepare(q.sql).get(...q.params) as {
    count: number
    nullCount: number
    distinct_: number
  }
  return { count: r.count, nullCount: r.nullCount, distinct: r.distinct_ }
}

/**
 * The epoch-second span of values actually present in a time column.
 *
 * Exists so an empty time-filtered search can explain itself. "0 rows" is indistinguishable from a
 * true negative, and the analyst's real mistake is usually filtering on a column that doesn't mean
 * what they assumed — an AppCompatCache `LastModifiedTimeUTC` is the BINARY's mtime, so a March-2025
 * window legitimately matches nothing. Reporting the column's real span turns a dead end into an
 * obvious diagnosis.
 */
export function getTimeColumnRange(tabId: string, col: string, tkind: TimeKind): { tsMin: number | null; tsMax: number | null } {
  const e = get(tabId)
  const q = buildTimeRangeSql(col, tkind, e.table)
  const r = e.db.prepare(q.sql).get(...q.params) as { lo: string | number | null; hi: string | number | null }
  const toEpoch = (v: string | number | null): number | null => {
    if (v == null || v === '') return null
    if (tkind === 'epoch_ms') return Math.floor(Number(v) / 1000)
    if (tkind === 'epoch_s') return Number(v)
    const ms = Date.parse(String(v))
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
  }
  return { tsMin: toEpoch(r?.lo ?? null), tsMax: toEpoch(r?.hi ?? null) }
}

export function getMeta(tabId: string): CsvTableMeta | null {
  return tables.get(tabId)?.meta ?? null
}

export function closeTab(tabId: string): void {
  const e = tables.get(tabId)
  if (!e) return
  // Only legacy single-file entries own their connection; a workspace source shares the
  // workspace's connection (closed by closeWorkspace). The db file is persistent either way.
  if (e.ownsDb) {
    try {
      e.db.close()
    } catch {
      /* ignore */
    }
  }
  tables.delete(tabId)
}

export function closeAll(): void {
  for (const id of [...tables.keys()]) closeTab(id)
  for (const id of [...workspaces.keys()]) closeWorkspace(id)
}

/** Delete any leftover temp dbs from a prior crashed session. Call once at startup. */
export function sweepStaleTempDbs(): void {
  try {
    const dir = tmpdir()
    for (const f of readdirSync(dir)) {
      if (f.startsWith(TEMP_PREFIX)) {
        try {
          unlinkSync(join(dir, f))
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
}

function get(tabId: string): Entry {
  const e = tables.get(tabId)
  if (!e) throw new Error(`No open CSV table for tab ${tabId}`)
  return e
}

function removeDbFiles(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(dbPath + suffix)
    } catch {
      /* ignore */
    }
  }
}

function statSizeSafe(filePath: string): number {
  try {
    return statSync(filePath).size
  } catch {
    return 0
  }
}
