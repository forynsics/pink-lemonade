import Database from 'better-sqlite3'
import { join, basename } from 'path'
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
  writeSync,
  closeSync
} from 'fs'
import { parseCsvStream } from './parser'
import type { ColumnMap } from './sanitize'
import { detectColumnTime, type TimeKind } from './coltypes'
import {
  buildCreateTable,
  buildInsertSql,
  buildQueryRowsSql,
  buildExportSql,
  csvRow,
  buildFilterInsertChunkSql,
  buildFiltPageSql,
  buildTagApplyByFilterSql,
  buildTagClearByFilterSql,
  buildTagCountsSql,
  buildSweepScanSql,
  FILT_TABLE,
  buildDistinctSql,
  buildDistinctChunkSql,
  buildDistinctCountSql,
  DISTINCT_CAP,
  buildLongestSql,
  buildColumnValuesSql,
  buildStatsSql,
  maxRowsPerInsert,
  type Filter,
  type QueryOpts,
  type Sort
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
  if (columns.length === 0) throw new Error('No header row found in file')

  // Tag detected time columns from the sampled rows.
  columns = columns.map((c, i) => {
    const kind = detectColumnTime(samples[i] ?? [], c.original)
    return kind ? { ...c, time: kind } : c
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
export function setWorkspaceDir(dir: string): string {
  const s = readSettings()
  s.workspaceDir = dir
  try {
    writeFileSync(settingsPath(), JSON.stringify(s, null, 2))
  } catch {
    /* ignore */
  }
  return getWorkspaceDir()
}

// ---- Enrichment config (lives under the `enrich` key in the same settings.json) ----
// e.g. { maxmindDbPath: '…/GeoLite2-City.mmdb' }. No secrets today (MaxMind needs none); when a
// network provider with an API key arrives, the key should go through Electron safeStorage, not here.
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

function workspaceDbPath(wsId: string): string {
  return join(getWorkspaceDir(), `${safe(wsId)}.workspace`)
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
    'CREATE TABLE sources (id INTEGER PRIMARY KEY, name TEXT, original_path TEXT, row_count INTEGER, num_cols INTEGER, added_at INTEGER)'
  )
  db.exec(
    'CREATE TABLE source_columns (source_id INTEGER, idx INTEGER, name TEXT, original TEXT, time TEXT, PRIMARY KEY(source_id, idx))'
  )
  db.exec(TAGS_DDL)
  db.exec(INTEL_HITS_DDL)
  applyQueryPragmas(db)
  workspaces.set(wsId, { db, dbPath, name, nextSourceId: 0 })
  return { wsId, dbPath, name, sources: [], intelMode: 'global' }
}

/** Ingest a CSV as a new source (data_<id>) in an open workspace; updates the catalog. */
export async function addSource(args: {
  wsId: string
  filePath: string
  sourceName: string
  onProgress?: (p: { bytes: number; rows: number; total: number }) => void
  signal?: AbortSignal
}): Promise<SourceInfo> {
  const w = workspaces.get(args.wsId)
  if (!w) throw new Error(`Workspace not open: ${args.wsId}`)
  const sourceId = w.nextSourceId
  w.db.pragma('journal_mode = OFF')
  w.db.pragma('synchronous = OFF')
  let columns: ColumnMap[]
  let rowCount: number
  try {
    ;({ columns, rowCount } = await ingestInto(w.db, `data_${sourceId}`, args.filePath, args.onProgress, args.signal))
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
  const setCol = w.db.prepare('INSERT INTO source_columns (source_id, idx, name, original, time) VALUES (?, ?, ?, ?, ?)')
  w.db.transaction(() => columns.forEach((c, i) => setCol.run(sourceId, i, c.name, c.original, c.time ?? null)))()
  w.db
    .prepare('INSERT INTO sources (id, name, original_path, row_count, num_cols, added_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(sourceId, args.sourceName, args.filePath, rowCount, columns.length, Date.now())
  w.nextSourceId = sourceId + 1
  registerSource(args.wsId, sourceId, args.sourceName, columns, rowCount, w.db, w.dbPath)
  return { sourceId, name: args.sourceName, columns, rowCount }
}

/** Open an existing workspace db and register all its sources (no re-ingest). */
export function openWorkspace(wsId: string, dbPath: string): WorkspaceInfo {
  closeWorkspace(wsId)
  if (!existsSync(dbPath)) throw new Error('Workspace file not found')
  const db = new Database(dbPath)
  let metaRows: Array<{ key: string; value: string }>
  let srcRows: Array<{ id: number; name: string; row_count: number }>
  try {
    metaRows = db.prepare('SELECT key, value FROM ws_meta').all() as typeof metaRows
    srcRows = db.prepare('SELECT id, name, row_count FROM sources ORDER BY id').all() as typeof srcRows
  } catch {
    db.close()
    throw new Error('Not a pink-lemonade workspace')
  }
  db.exec(TAGS_DDL) // workspaces created before tagging shipped won't have this table yet
  db.exec(INTEL_HITS_DDL) // …nor intel-sweep sightings
  applyQueryPragmas(db)
  const m = Object.fromEntries(metaRows.map((r) => [r.key, r.value]))
  const name = m.name ?? basename(dbPath)
  const colStmt = db.prepare('SELECT name, original, time FROM source_columns WHERE source_id = ? ORDER BY idx')
  const sources: SourceInfo[] = []
  let maxId = -1
  for (const s of srcRows) {
    const colRows = colStmt.all(s.id) as Array<{ name: string; original: string; time: string | null }>
    const columns: ColumnMap[] = colRows.map((c) =>
      c.time ? { name: c.name, original: c.original, time: c.time as TimeKind } : { name: c.name, original: c.original }
    )
    registerSource(wsId, s.id, s.name, columns, s.row_count, db, dbPath)
    sources.push({ sourceId: s.id, name: s.name, columns, rowCount: s.row_count })
    maxId = Math.max(maxId, s.id)
  }
  workspaces.set(wsId, { db, dbPath, name, nextSourceId: maxId + 1 })
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

/** Remove a source (imported file) from a workspace: drop its table + catalog rows + tags. */
export function removeSource(wsId: string, sourceId: number): void {
  const w = workspaces.get(wsId)
  if (!w || !Number.isInteger(sourceId)) return
  w.db.exec(`DROP TABLE IF EXISTS data_${sourceId}`) // indexes drop with the table
  w.db.exec(`DROP TABLE IF EXISTS _pl_filt_${sourceId}`)
  w.db.prepare('DELETE FROM sources WHERE id = ?').run(sourceId)
  w.db.prepare('DELETE FROM source_columns WHERE source_id = ?').run(sourceId)
  w.db.prepare('DELETE FROM tags WHERE source_id = ?').run(sourceId)
  tables.delete(sourceKey(wsId, sourceId))
}

// ---- Row tags (Phase 2 capstone) ----
// One row of `tags` per tagged row, keyed by (source_id, positional rowid). Row identity is the
// rowid of data_<source_id> — stable because the workspace db is never rebuilt (the rows keep
// their original insert order forever). One tag per row: setting replaces, clearing deletes.
const TAGS_DDL =
  'CREATE TABLE IF NOT EXISTS tags (source_id INTEGER NOT NULL, rid INTEGER NOT NULL, tag TEXT NOT NULL, note TEXT, updated_at INTEGER, PRIMARY KEY (source_id, rid))'

// Intel-sweep results: one row per (source row, matched indicator). A row with ≥1 entry here is a
// "sighting". Keyed independently of `tags`, so a row can carry an intent tag AND be a sighting.
const INTEL_HITS_DDL =
  'CREATE TABLE IF NOT EXISTS intel_hits (source_id INTEGER NOT NULL, rid INTEGER NOT NULL, indicator TEXT NOT NULL, kind TEXT NOT NULL, hitset TEXT, PRIMARY KEY (source_id, rid, indicator))'

/** Every tag in a source, as [rid, tag] pairs — the renderer holds these in a Map for markers. */
export function listTags(wsId: string, sourceId: number): Array<{ rid: number; tag: string }> {
  const w = workspaces.get(wsId)
  if (!w || !Number.isInteger(sourceId)) return []
  return w.db.prepare('SELECT rid, tag FROM tags WHERE source_id = ?').all(sourceId) as Array<{
    rid: number
    tag: string
  }>
}

/** Set (or, when tag is null, clear) the tag on a set of rows. Returns the affected tag counts. */
export function setTags(wsId: string, sourceId: number, rids: number[], tag: string | null): void {
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
      'INSERT INTO tags (source_id, rid, tag, updated_at) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT(source_id, rid) DO UPDATE SET tag = excluded.tag, updated_at = excluded.updated_at'
    )
    w.db.transaction(() => ids.forEach((r) => up.run(sourceId, r, tag, now)))()
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
  tag: string | null
): { count: number } {
  const w = workspaces.get(wsId)
  const e = tables.get(sourceKey(wsId, sourceId))
  if (!w || !e || !Number.isInteger(sourceId)) return { count: 0 }
  const cols = e.meta.columns
  const q =
    tag == null
      ? buildTagClearByFilterSql(cols, filters, search, sourceId, e.table)
      : buildTagApplyByFilterSql(cols, filters, search, sourceId, tag, Date.now(), e.table)
  const info = w.db.prepare(q.sql).run(...q.params)
  e.filt = undefined // matching set's tags changed → invalidate the cached filter index
  return { count: info.changes }
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
  for (let lo = 0; lo < max; lo += FILT_CHUNK) {
    if (shouldAbort()) return null
    const hi = Math.min(lo + FILT_CHUNK, max)
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
  opts: { filters?: Filter[]; search?: string; sort?: Sort },
  outPath: string
): { rows: number } {
  const e = get(tabId)
  // A big sorted export benefits from the same on-demand column index the grid uses.
  if (opts.sort) ensureSortIndex(tabId, opts.sort.col, !!opts.sort.numeric)
  const q = buildExportSql(e.meta.columns, opts, e.table)
  const stmt = e.db.prepare(q.sql).raw(true)
  const fd = openSync(outPath, 'w')
  try {
    let buf = csvRow(e.meta.columns.map((c) => c.original)) + '\n'
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

export function getColumnUniqueValues(
  tabId: string,
  col: string,
  filters?: Filter[],
  limit?: number
): Array<{ val: string; cnt: number }> {
  const e = get(tabId)
  const q = buildDistinctSql(col, filters, limit ?? 1000, e.table)
  return e.db.prepare(q.sql).all(...q.params) as Array<{ val: string; cnt: number }>
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

export function getColumnDistinctCount(tabId: string, col: string, filters?: Filter[]): number {
  const e = get(tabId)
  const q = buildDistinctCountSql(col, filters, e.table)
  return (e.db.prepare(q.sql).get(...q.params) as { n: number }).n
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
