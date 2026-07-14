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
import { sanitizeHeaders, type ColumnMap } from './sanitize'
import { detectColumnTime, type TimeKind } from './coltypes'
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
  /** Absolute path the file was imported from — lets the UI detect re-imports of the same file. */
  originalPath: string
  /** Analyst-assigned grouping label (the host/system/origin the evidence belongs to, e.g. "DESKTOP6",
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

// ---- AI assistant config (lives under the `ai` key in the same settings.json) ----
// Non-secret only: { provider: 'claude-code', model }. The assistant is Claude-only, run through the
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
    'CREATE TABLE source_columns (source_id INTEGER, idx INTEGER, name TEXT, original TEXT, time TEXT, PRIMARY KEY(source_id, idx))'
  )
  db.exec(TAGS_DDL)
  db.exec(INTEL_HITS_DDL)
  db.exec(AI_MARKS_DDL)
  db.exec(FINDINGS_DDL)
  db.exec(FINDING_HITS_DDL)
  db.exec(EVENTS_DDL)
  db.exec(EVENT_EVIDENCE_DDL)
  db.exec(EVENT_ENTITIES_DDL)
  db.exec(IOCS_DDL)
  db.exec(AI_COVERAGE_DDL)
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
  return { sourceId, name: args.sourceName, columns, rowCount, originalPath: args.filePath, group: null }
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
    const header = rows[0].slice()
    while (header.length < width) header.push('')
    out.push({ name: ws.name, header, rows: rows.slice(1) })
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
    return kind ? { ...c, time: kind } : c
  })
  return { columns, rowCount }
}

/** Ingest each non-empty worksheet of an Excel workbook as its own source in an open workspace.
 *  Multi-sheet workbooks name sources "<file> — <sheet>"; a single-sheet workbook keeps the file name. */
export async function addXlsxSources(args: {
  wsId: string
  filePath: string
  sourceName: string
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
    const sourceId = w.nextSourceId
    w.db.pragma('journal_mode = OFF')
    w.db.pragma('synchronous = OFF')
    let columns: ColumnMap[]
    let rowCount: number
    try {
      ;({ columns, rowCount } = ingestRowsInto(w.db, `data_${sourceId}`, sheet.header, sheet.rows, args.onProgress, args.signal))
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
    const srcName = multi ? `${args.sourceName} — ${sheet.name}` : args.sourceName
    const setCol = w.db.prepare('INSERT INTO source_columns (source_id, idx, name, original, time) VALUES (?, ?, ?, ?, ?)')
    w.db.transaction(() => columns.forEach((c, i) => setCol.run(sourceId, i, c.name, c.original, c.time ?? null)))()
    w.db
      .prepare('INSERT INTO sources (id, name, original_path, row_count, num_cols, added_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(sourceId, srcName, args.filePath, rowCount, columns.length, Date.now())
    w.nextSourceId = sourceId + 1
    registerSource(args.wsId, sourceId, srcName, columns, rowCount, w.db, w.dbPath)
    out.push({ sourceId, name: srcName, columns, rowCount, originalPath: args.filePath, group: null })
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
  const setCol = w.db.prepare('INSERT INTO source_columns (source_id, idx, name, original, time) VALUES (?, ?, ?, ?, ?)')
  w.db.transaction(() => columns.forEach((c, i) => setCol.run(sourceId, i, c.name, c.original, c.time ?? null)))()
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
  db.exec(FINDINGS_DDL) // …nor findings
  db.exec(FINDING_HITS_DDL)
  db.exec(EVENTS_DDL) // …nor events
  db.exec(EVENT_EVIDENCE_DDL)
  db.exec(EVENT_ENTITIES_DDL) // …nor the event-entity (user attribution) table
  db.exec(IOCS_DDL) // …nor the IOC catalog
  db.exec(AI_COVERAGE_DDL) // …nor the AI's triage-coverage record
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
    sources.push({ sourceId: s.id, name: s.name, columns, rowCount: s.row_count, originalPath: s.original_path ?? '', group: s.group_label ?? null })
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
  const setCol = w.db.prepare('INSERT INTO source_columns (source_id, idx, name, original, time) VALUES (?, ?, ?, ?, ?)')

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
      setCol.run(sourceId, idx, cK, spec.displayName, time ?? null)
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
  try {
    w.db.prepare('DELETE FROM finding_hits WHERE source_id = ?').run(sourceId)
    w.db.prepare('DELETE FROM event_evidence WHERE source_id = ?').run(sourceId)
  } catch {
    /* older workspace without the table */
  }
  tables.delete(sourceKey(wsId, sourceId))
}

// ---- Row tags (Phase 2 capstone) ----
// One row of `tags` per tagged row, keyed by (source_id, positional rowid). Row identity is the
// rowid of data_<source_id> — stable because the workspace db is never rebuilt (the rows keep
// their original insert order forever). One tag per row: setting replaces, clearing deletes.
const TAGS_DDL =
  'CREATE TABLE IF NOT EXISTS tags (source_id INTEGER NOT NULL, rid INTEGER NOT NULL, tag TEXT NOT NULL, note TEXT, updated_at INTEGER, actor TEXT, PRIMARY KEY (source_id, rid))'

/** Provenance of a tag: who applied it. `actor` is null for the analyst's own tags and 'ai' for ones
 *  the AI assistant applied — so AI tags can be shown distinctly and rolled up separately. Older
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

// Intel-sweep results: one row per (source row, matched indicator). A row with ≥1 entry here is a
// "sighting". Keyed independently of `tags`, so a row can carry an intent tag AND be a sighting.
const INTEL_HITS_DDL =
  'CREATE TABLE IF NOT EXISTS intel_hits (source_id INTEGER NOT NULL, rid INTEGER NOT NULL, indicator TEXT NOT NULL, kind TEXT NOT NULL, hitset TEXT, PRIMARY KEY (source_id, rid, indicator))'

// AI-accountability marks (✨): one row per row the AI assistant flagged while asserting something
// during triage. Its OWN dimension (independent of intent `tags` and `intel_hits`), so the analyst
// can filter to exactly what the assistant touched. `note` records what it asserted. Append-only by
// design — the assistant can add marks (no confirmation) but nothing here edits other data.
const AI_MARKS_DDL =
  'CREATE TABLE IF NOT EXISTS ai_marks (source_id INTEGER NOT NULL, rid INTEGER NOT NULL, note TEXT, created_at INTEGER, PRIMARY KEY (source_id, rid))'

// Findings (the constellation substrate): a finding is a validated indicator/artifact the AI (or
// analyst) asserts is relevant. `finding_hits` records WHERE it actually appears — one row per
// source it was found in, with a capped sample of matching row ids. A finding is only ever stored
// when it has ≥1 hit (it must exist in the timeline), which is what makes the constellation
// hallucination-proof. The per-source hits are the graph's branches (IOC → artifact → rows).
const FINDINGS_DDL =
  'CREATE TABLE IF NOT EXISTS findings (id TEXT PRIMARY KEY, value TEXT NOT NULL, kind TEXT, label TEXT, note TEXT, created_at INTEGER)'
const FINDING_HITS_DDL =
  'CREATE TABLE IF NOT EXISTS finding_hits (finding_id TEXT NOT NULL, source_id INTEGER NOT NULL, source_name TEXT, count INTEGER, rids TEXT, PRIMARY KEY (finding_id, source_id))'

// Events (the Artifact Constellation's real substrate): an EVENT is an action that transpired on the
// system (a TTP). `event_evidence` records the specific rows across artifacts that corroborate it —
// many per event, possibly several in one source (rowid PK, unlike finding_hits). An event is stored
// only when it has ≥1 validated evidence row. Each evidence carries the `matched` term (so the
// constellation can pivot to those exact rows). `technique` is an optional ATT&CK attribution.
const EVENTS_DDL =
  'CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, label TEXT NOT NULL, description TEXT, technique TEXT, created_at INTEGER, actor TEXT)'
const EVENT_EVIDENCE_DDL =
  'CREATE TABLE IF NOT EXISTS event_evidence (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL, source_id INTEGER NOT NULL, source_name TEXT, matched TEXT, count INTEGER, rids TEXT, ts_min INTEGER, ts_max INTEGER)'
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
}

/** `actor` ('ai' | 'analyst') marks who authored an event's interpretation — added after the table
 *  shipped; back-fill older workspaces (a NULL actor is read as 'ai'). Lets analyst-authored events be
 *  flagged in the UI and protected from being overwritten by the AI's record_event. */
function ensureEventActorColumn(db: Database.Database): void {
  const cols = db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === 'actor')) db.exec('ALTER TABLE events ADD COLUMN actor TEXT')
}

// IOC catalog: indicators the AI (or analyst) encounters during the investigation, typed by a fixed
// taxonomy. Workspace-level (not per-source). This is just a catalog — nothing here pushes to the
// Intel/enrichment grid; sending an (enrichable) IOC there is a deliberate human action.
const IOCS_DDL =
  'CREATE TABLE IF NOT EXISTS iocs (id TEXT PRIMARY KEY, value TEXT NOT NULL, type TEXT NOT NULL, context TEXT, created_at INTEGER)'
// Which sources the AI assistant has examined (triage coverage). Persisted so coverage survives a
// session/Continue boundary — the agent resumes without re-touching already-examined sources. Source
// of truth is the live data; this just records "the agent has opened and read this source's data".
const AI_COVERAGE_DDL = 'CREATE TABLE IF NOT EXISTS ai_coverage (source_id INTEGER PRIMARY KEY, examined_at INTEGER)'

/** Every tag in a source, as {rid, tag, actor} — the renderer holds these in a Map for markers.
 *  `actor` is null for analyst tags, 'ai' for assistant-applied ones. */
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
 *  analyst, 'ai' = assistant). */
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

// ---- AI-accountability marks (✨): the AI assistant's own append-only mark dimension ----

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

/** Clear every AI mark in a source (a "reset the assistant's marks" / new-investigation action). */
export function clearAiMarks(wsId: string, sourceId: number): void {
  const w = workspaces.get(wsId)
  if (!w || !Number.isInteger(sourceId)) return
  w.db.prepare('DELETE FROM ai_marks WHERE source_id = ?').run(sourceId)
  const e = tables.get(sourceKey(wsId, sourceId))
  if (e) e.filt = undefined
}

// ---- Findings (the constellation substrate) ----

export interface FindingHit {
  sourceId: number
  sourceName: string
  count: number
  rids: number[]
}
export interface FindingRecord {
  id: string
  value: string
  kind: string | null
  label: string | null
  note: string | null
}

function safeRids(s: string): number[] {
  try {
    const a = JSON.parse(s)
    return Array.isArray(a) ? a.filter((n) => Number.isInteger(n)) : []
  } catch {
    return []
  }
}

/** Upsert a finding and replace its per-source hits (the validated presence across artifacts). */
export function recordFinding(wsId: string, finding: FindingRecord, hits: FindingHit[]): void {
  const w = workspaces.get(wsId)
  if (!w) return
  w.db.exec(FINDINGS_DDL)
  w.db.exec(FINDING_HITS_DDL)
  const now = Date.now()
  const upF = w.db.prepare(
    'INSERT INTO findings (id, value, kind, label, note, created_at) VALUES (?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET value = excluded.value, kind = excluded.kind, label = excluded.label, note = excluded.note'
  )
  const delH = w.db.prepare('DELETE FROM finding_hits WHERE finding_id = ?')
  const insH = w.db.prepare('INSERT OR REPLACE INTO finding_hits (finding_id, source_id, source_name, count, rids) VALUES (?, ?, ?, ?, ?)')
  w.db.transaction(() => {
    upF.run(finding.id, finding.value, finding.kind, finding.label, finding.note, now)
    delH.run(finding.id)
    for (const h of hits) insH.run(finding.id, h.sourceId, h.sourceName, h.count, JSON.stringify(h.rids))
  })()
}

/** All findings in a workspace, each with its per-source hits. */
export function listFindings(wsId: string): Array<FindingRecord & { createdAt: number; hits: FindingHit[] }> {
  const w = workspaces.get(wsId)
  if (!w) return []
  w.db.exec(FINDINGS_DDL)
  w.db.exec(FINDING_HITS_DDL)
  const findings = w.db.prepare('SELECT id, value, kind, label, note, created_at FROM findings ORDER BY created_at').all() as Array<{
    id: string
    value: string
    kind: string | null
    label: string | null
    note: string | null
    created_at: number
  }>
  const hitStmt = w.db.prepare('SELECT source_id, source_name, count, rids FROM finding_hits WHERE finding_id = ?')
  return findings.map((f) => ({
    id: f.id,
    value: f.value,
    kind: f.kind,
    label: f.label,
    note: f.note,
    createdAt: f.created_at,
    hits: (hitStmt.all(f.id) as Array<{ source_id: number; source_name: string; count: number; rids: string }>).map((h) => ({
      sourceId: h.source_id,
      sourceName: h.source_name,
      count: h.count,
      rids: safeRids(h.rids)
    }))
  }))
}

export function deleteFinding(wsId: string, id: string): void {
  const w = workspaces.get(wsId)
  if (!w) return
  w.db.transaction(() => {
    w.db.prepare('DELETE FROM finding_hits WHERE finding_id = ?').run(id)
    w.db.prepare('DELETE FROM findings WHERE id = ?').run(id)
  })()
}

export function clearFindings(wsId: string): void {
  const w = workspaces.get(wsId)
  if (!w) return
  w.db.exec(FINDINGS_DDL)
  w.db.exec(FINDING_HITS_DDL)
  w.db.exec('DELETE FROM finding_hits')
  w.db.exec('DELETE FROM findings')
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
}
export interface EventRecord {
  id: string
  label: string
  description: string | null
  technique: string | null
  /** User account(s) the event involves (curated attribution). Omit (undefined) to leave any existing
   *  set untouched on re-record; pass [] to explicitly clear. */
  users?: string[]
}

/** Upsert an event and MERGE in its evidence (additive, deduped by source_id+matched). Merge — not
 *  replace — so the assistant can corroborate the same event across more artifacts over several
 *  record_event calls, and each call's evidence accumulates instead of clobbering the last. Re-supplying
 *  the same (source, matched) is idempotent (count/rids refreshed); new (source, matched) pairs append. */
export function recordEvent(wsId: string, event: EventRecord, evidence: EventEvidence[], actor: 'ai' | 'analyst' = 'ai'): void {
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
  const now = Date.now()
  const upE = w.db.prepare(
    'INSERT INTO events (id, label, description, technique, created_at, actor) VALUES (?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET label = excluded.label, description = excluded.description, technique = excluded.technique, actor = excluded.actor'
  )
  // Clean an evidence row's per-kind spans before deleting the row itself (no FK cascade configured).
  const delTimes = w.db.prepare(
    'DELETE FROM evidence_times WHERE evidence_id IN (SELECT id FROM event_evidence WHERE event_id = ? AND source_id = ? AND matched IS ?)'
  )
  const delOne = w.db.prepare('DELETE FROM event_evidence WHERE event_id = ? AND source_id = ? AND matched IS ?')
  const insEv = w.db.prepare('INSERT INTO event_evidence (event_id, source_id, source_name, matched, count, rids, ts_min, ts_max) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  const insTime = w.db.prepare('INSERT INTO evidence_times (evidence_id, kind, col_ref, ts_min, ts_max) VALUES (?, ?, ?, ?, ?)')
  const delUsers = w.db.prepare("DELETE FROM event_entities WHERE event_id = ? AND kind = 'user'")
  const insUser = w.db.prepare("INSERT OR IGNORE INTO event_entities (event_id, kind, value) VALUES (?, 'user', ?)")
  w.db.transaction(() => {
    upE.run(event.id, event.label, event.description, event.technique, now, actor)
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
      const spans = e.spans ?? []
      const tsMin = spans.length ? Math.min(...spans.map((s) => s.tsMin)) : e.tsMin
      const tsMax = spans.length ? Math.max(...spans.map((s) => s.tsMax)) : e.tsMax
      const evId = insEv.run(event.id, e.sourceId, e.sourceName, e.matched, e.count, JSON.stringify(e.rids), tsMin, tsMax).lastInsertRowid
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
export function listEvents(wsId: string): Array<EventRecord & { createdAt: number; actor: 'ai' | 'analyst'; evidence: EventEvidence[] }> {
  const w = workspaces.get(wsId)
  if (!w) return []
  w.db.exec(EVENTS_DDL)
  w.db.exec(EVENT_EVIDENCE_DDL)
  w.db.exec(EVIDENCE_TIMES_DDL)
  w.db.exec(EVENT_ENTITIES_DDL)
  ensureEvidenceTimeColumns(w.db)
  ensureEventActorColumn(w.db)
  const events = w.db.prepare('SELECT id, label, description, technique, created_at, actor FROM events ORDER BY created_at').all() as Array<{
    id: string
    label: string
    description: string | null
    technique: string | null
    created_at: number
    actor: string | null
  }>
  const evStmt = w.db.prepare('SELECT id, source_id, source_name, matched, count, rids, ts_min, ts_max FROM event_evidence WHERE event_id = ? ORDER BY id')
  const spStmt = w.db.prepare('SELECT kind, col_ref, ts_min, ts_max FROM evidence_times WHERE evidence_id = ? ORDER BY id')
  const usrStmt = w.db.prepare("SELECT value FROM event_entities WHERE event_id = ? AND kind = 'user' ORDER BY value")
  return events.map((e) => ({
    id: e.id,
    label: e.label,
    description: e.description,
    technique: e.technique,
    createdAt: e.created_at,
    actor: e.actor === 'analyst' ? 'analyst' : 'ai',
    users: (usrStmt.all(e.id) as Array<{ value: string }>).map((u) => u.value),
    evidence: (evStmt.all(e.id) as Array<{ id: number; source_id: number; source_name: string; matched: string; count: number; rids: string; ts_min: number | null; ts_max: number | null }>).map((v) => ({
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
      tsMax: v.ts_max ?? null
    }))
  }))
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
  fields: { label: string; description: string | null; technique: string | null; users: string[] }
): void {
  const w = workspaces.get(wsId)
  if (!w) return
  w.db.exec(EVENTS_DDL)
  w.db.exec(EVENT_ENTITIES_DDL)
  ensureEventActorColumn(w.db)
  w.db.transaction(() => {
    w.db.prepare("UPDATE events SET label = ?, description = ?, technique = ?, actor = 'analyst' WHERE id = ?").run(
      String(fields.label ?? '').slice(0, 300),
      fields.description != null ? String(fields.description).slice(0, 2000) : null,
      fields.technique != null ? String(fields.technique).slice(0, 200) : null,
      id
    )
    w.db.prepare("DELETE FROM event_entities WHERE event_id = ? AND kind = 'user'").run(id)
    const insUser = w.db.prepare("INSERT OR IGNORE INTO event_entities (event_id, kind, value) VALUES (?, 'user', ?)")
    for (const u of normalizeUsers(fields.users ?? [])) insUser.run(id, u)
  })()
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

/** Clear the coverage record (a future "re-triage from scratch" reset). */
export function clearCoverage(wsId: string): void {
  const w = workspaces.get(wsId)
  if (!w) return
  w.db.exec(AI_COVERAGE_DDL)
  w.db.exec('DELETE FROM ai_coverage')
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

// ---- AI conversations: saved chat transcripts (persistent, per workspace) ----------------------
// Each workspace keeps a history of assistant conversations so a chat is never lost: "New chat"
// archives the current one and starts another, and any past one can be resumed. `turns` is the
// renderer's display-state JSON (opaque here). "General" (no-workspace) chats live in renderer
// localStorage, not here. Stored per-workspace so they travel with the .workspace file, alongside
// the investigation plan/events/iocs.

const AI_CONV_DDL =
  'CREATE TABLE IF NOT EXISTS ai_conversations (id TEXT PRIMARY KEY, title TEXT, created_at INTEGER, updated_at INTEGER, turn_count INTEGER, turns TEXT)'

const CONV_TURNS_MAX_BYTES = 4_000_000 // sanity cap per conversation; refuse to bloat the db

export interface ConversationMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  turnCount: number
}
export interface Conversation extends ConversationMeta {
  turns: unknown[]
}

function ensureConvTable(w: { db: Database.Database }): void {
  w.db.exec(AI_CONV_DDL)
}

/** List a workspace's conversations (newest first), without the heavy `turns` payload. */
export function listConversations(wsId: string): ConversationMeta[] {
  const w = workspaces.get(wsId)
  if (!w) return []
  ensureConvTable(w)
  const rows = w.db
    .prepare('SELECT id, title, created_at, updated_at, turn_count FROM ai_conversations ORDER BY updated_at DESC')
    .all() as Array<{ id: string; title: string | null; created_at: number; updated_at: number; turn_count: number | null }>
  return rows.map((r) => ({
    id: r.id,
    title: r.title ?? '',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    turnCount: r.turn_count ?? 0
  }))
}

/** Read one full conversation (with its turns), or null if missing. */
export function getConversation(wsId: string, id: string): Conversation | null {
  const w = workspaces.get(wsId)
  if (!w) return null
  ensureConvTable(w)
  const row = w.db
    .prepare('SELECT id, title, created_at, updated_at, turn_count, turns FROM ai_conversations WHERE id = ?')
    .get(id) as
    | { id: string; title: string | null; created_at: number; updated_at: number; turn_count: number | null; turns: string | null }
    | undefined
  if (!row) return null
  let turns: unknown[] = []
  try {
    const parsed = row.turns ? JSON.parse(row.turns) : []
    if (Array.isArray(parsed)) turns = parsed
  } catch {
    turns = []
  }
  return { id: row.id, title: row.title ?? '', createdAt: row.created_at, updatedAt: row.updated_at, turnCount: row.turn_count ?? turns.length, turns }
}

/** Create-or-replace a conversation's title + turns. Preserves the original created_at. Returns the
 *  new updatedAt (or null if the workspace is gone or the payload is too large to store). */
export function upsertConversation(
  wsId: string,
  conv: { id: string; title?: string; turns: unknown[] }
): { updatedAt: number } | null {
  const w = workspaces.get(wsId)
  if (!w || !conv?.id) return null
  ensureConvTable(w)
  const turns = Array.isArray(conv.turns) ? conv.turns : []
  const turnsJson = JSON.stringify(turns)
  if (turnsJson.length > CONV_TURNS_MAX_BYTES) return null // don't bloat the db with a runaway transcript
  const now = Date.now()
  const existing = w.db.prepare('SELECT created_at FROM ai_conversations WHERE id = ?').get(conv.id) as { created_at: number } | undefined
  const createdAt = existing?.created_at ?? now
  const title = String(conv.title ?? '').slice(0, 200)
  w.db
    .prepare('INSERT OR REPLACE INTO ai_conversations (id, title, created_at, updated_at, turn_count, turns) VALUES (?, ?, ?, ?, ?, ?)')
    .run(conv.id, title, createdAt, now, turns.length, turnsJson)
  return { updatedAt: now }
}

/** Rename a conversation (title only; leaves updated_at so the list order is stable). */
export function renameConversation(wsId: string, id: string, title: string): void {
  const w = workspaces.get(wsId)
  if (!w) return
  ensureConvTable(w)
  w.db.prepare('UPDATE ai_conversations SET title = ? WHERE id = ?').run(String(title ?? '').slice(0, 200), id)
}

/** Delete a conversation for good. */
export function deleteConversation(wsId: string, id: string): void {
  const w = workspaces.get(wsId)
  if (!w) return
  ensureConvTable(w)
  w.db.prepare('DELETE FROM ai_conversations WHERE id = ?').run(id)
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
