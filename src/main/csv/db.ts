import Database from 'better-sqlite3'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'
import { statSync, unlinkSync, readdirSync } from 'fs'
import { parseCsvStream } from './parser'
import type { ColumnMap } from './sanitize'
import { detectColumnTime } from './coltypes'
import {
  buildCreateTable,
  buildInsertSql,
  buildQueryRowsSql,
  buildCountChunkSql,
  buildDistinctSql,
  buildDistinctCountSql,
  buildLongestSql,
  buildColumnValuesSql,
  buildStatsSql,
  maxRowsPerInsert,
  type Filter,
  type QueryOpts
} from './sql'

// The ONLY module that loads the native better-sqlite3 binding. One on-disk temp .db per
// CSV tab, created on ingest and deleted on close. The renderer never touches this — it
// reaches the data through the csv:* IPC, which calls these functions and returns small
// result sets only.

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
}

const TEMP_PREFIX = 'pl_csv_'
const tables = new Map<string, Entry>()

function tempDbPath(tabId: string): string {
  return join(tmpdir(), `${TEMP_PREFIX}${safe(tabId)}_${randomBytes(4).toString('hex')}.db`)
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

/** Stream a CSV from disk into a fresh temp SQLite db and register it under tabId. */
export async function ingestCsv(args: IngestArgs): Promise<CsvTableMeta> {
  const { tabId, filePath, sourceName } = args
  closeTab(tabId) // drop any prior table reusing this id

  const dbPath = tempDbPath(tabId)
  const db = new Database(dbPath)
  applyImportPragmas(db)

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

  try {
    const res = await parseCsvStream(
      filePath,
      {
        onHeader: ({ columns: cols }) => {
          columns = cols
          numCols = cols.length
          for (let c = 0; c < numCols; c++) samples.push([])
          db.exec(buildCreateTable(cols))
          multiN = maxRowsPerInsert(numCols)
          insertMulti = db.prepare(buildInsertSql(cols, multiN))
          insertOne = db.prepare(buildInsertSql(cols, 1))
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
        onProgress: (bytes, rows) => args.onProgress?.({ bytes, rows, total })
      },
      { signal: args.signal }
    )

    if (res.canceled) throw new CsvIngestCanceled()
    if (columns.length === 0) throw new Error('No header row found in file')

    // Tag detected time columns from the sampled rows.
    columns = columns.map((c, i) => {
      const kind = detectColumnTime(samples[i] ?? [], c.original)
      return kind ? { ...c, time: kind } : c
    })

    applyQueryPragmas(db)
    const meta: CsvTableMeta = { tabId, dbPath, sourceName, columns, rowCount }
    tables.set(tabId, { db, meta })
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

export function queryRows(tabId: string, opts: QueryOpts): { rows: string[][] } {
  const e = get(tabId)
  const q = buildQueryRowsSql(e.meta.columns, opts)
  const rows = e.db.prepare(q.sql).raw(true).all(...q.params) as string[][]
  return { rows }
}

const COUNT_CHUNK = 1_000_000

/**
 * Count a filtered/searched result set in rowid chunks, yielding to the event loop between each
 * so the main process stays responsive (window fetches, other tabs) and the run can be aborted
 * mid-flight. `onPartial` reports the running total after each chunk (for a live count + scrollbar
 * that grows as it scans). Returns the final count, or null if `shouldAbort` tripped (superseded).
 */
export async function countMatches(
  tabId: string,
  filters: Filter[] | undefined,
  search: string,
  onPartial: (count: number, scanned: number, max: number) => void,
  shouldAbort: () => boolean
): Promise<number | null> {
  const e = get(tabId)
  const max = e.meta.rowCount
  let total = 0
  for (let lo = 0; lo < max; lo += COUNT_CHUNK) {
    if (shouldAbort()) return null
    const hi = Math.min(lo + COUNT_CHUNK, max)
    const q = buildCountChunkSql(e.meta.columns, filters, search || undefined, lo, hi)
    total += (e.db.prepare(q.sql).get(...q.params) as { n: number }).n
    onPartial(total, hi, max)
    await new Promise((resolve) => setImmediate(resolve)) // yield between chunks
  }
  return total
}

export function getColumnUniqueValues(
  tabId: string,
  col: string,
  filters?: Filter[],
  limit?: number
): Array<{ val: string; cnt: number }> {
  const e = get(tabId)
  const q = buildDistinctSql(col, filters, limit ?? 1000)
  return e.db.prepare(q.sql).all(...q.params) as Array<{ val: string; cnt: number }>
}

export function getColumnDistinctCount(tabId: string, col: string, filters?: Filter[]): number {
  const e = get(tabId)
  const q = buildDistinctCountSql(col, filters)
  return (e.db.prepare(q.sql).get(...q.params) as { n: number }).n
}

export function getColumnLongest(tabId: string, col: string): string {
  const e = get(tabId)
  const q = buildLongestSql(col)
  const r = e.db.prepare(q.sql).get(...q.params) as { val: string | null } | undefined
  return r?.val ?? ''
}

export function getColumnValues(tabId: string, col: string, filters?: Filter[]): string[] {
  const e = get(tabId)
  const q = buildColumnValuesSql(col, filters)
  const rows = e.db.prepare(q.sql).raw(true).all(...q.params) as unknown[][]
  return rows.map((r) => String(r[0] ?? ''))
}

export function getColumnStats(tabId: string, col: string): CsvColumnStats {
  const e = get(tabId)
  const q = buildStatsSql(col)
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
  try {
    e.db.close()
  } catch {
    /* ignore */
  }
  removeDbFiles(e.meta.dbPath)
  tables.delete(tabId)
}

export function closeAll(): void {
  for (const id of [...tables.keys()]) closeTab(id)
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
