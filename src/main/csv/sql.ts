// Pure SQL builders for the CSV table — no better-sqlite3 import, fully unit-testable.
//
// Column identifiers are ALWAYS the positional `c0..cN` names (never user text); assertCol
// whitelists them, so column names can be interpolated safely while all *values* are bound
// as parameters. This is the single SQL-injection boundary.

import type { ColumnMap } from './sanitize'
import type { TimeKind } from './coltypes'

const COL_RE = /^c\d+$/
function assertCol(name: string): void {
  if (!COL_RE.test(name)) throw new Error(`Invalid column identifier: ${JSON.stringify(name)}`)
}

// A source's data table is `data` (legacy single-table) or `data_<id>` (a workspace source); its
// materialized filter index is `_pl_filt` / `_pl_filt_<id>`. These are interpolated into SQL, so —
// like column names — they must come from this whitelist, never user text.
const TABLE_RE = /^data(_\d+)?$/
const FILT_RE = /^_pl_filt(_\d+)?$/
function assertTable(name: string): void {
  if (!TABLE_RE.test(name)) throw new Error(`Invalid table identifier: ${JSON.stringify(name)}`)
}
function assertFilt(name: string): void {
  if (!FILT_RE.test(name)) throw new Error(`Invalid filter-index identifier: ${JSON.stringify(name)}`)
}

export const HOST_PARAM_LIMIT = 32766
export const MAX_ROWS_LIMIT = 10_000
export const DISTINCT_CAP = 100_000
export const VALUES_CAP = 1_000_000

// A row filter is one of:
//  • single-value predicate (equals / contains)
//  • multi-value set membership (`in`) — one chip holding several values for a column
//  • `timearound` — rows whose (epoch-normalised) time column is within ±deltaSec of `value`
export type Filter =
  | { col: string; op: 'eq' | 'like' | 'neq' | 'nlike'; value: string }
  | { col: string; op: 'in'; values: string[] }
  | { col: string; op: 'timearound'; value: string; tkind: TimeKind; deltaSec: number }
  // Open/closed range on a time column in epoch seconds: from→`>=`, to→`<=`, both→between.
  | { col: string; op: 'timerange'; tkind: TimeKind; from?: number; to?: number }
  // Row-tag membership: rows whose (source_id, rowid) carry ANY of these tags in the `tags` table
  // (OR across the set — a row has one tag, so AND would match nothing). `exclude` flips it to
  // "rows that have NONE of these tags" (right-click a tag facet).
  | { op: 'tag'; tags: string[]; exclude?: boolean }
  // Intel-sweep sightings: rows that carry at least one hit in the `intel_hits` table. With no
  // `indicators`, it's a "show only sightings" toggle; with them, it narrows to rows that hit ANY of
  // those specific indicators (the "zero in" facet). `exclude` flips it to "rows that do NOT hit
  // (any of) these" (right-click an indicator). Like the tag op, it resolves by source id.
  | { op: 'sighting'; indicators?: string[]; exclude?: boolean }
  // AI-accountability marks: rows the AI agent marked (✨) while asserting something during
  // triage. Its own dimension (the `ai_marks` table), so the analyst can filter to exactly what the
  // agent flagged. `exclude` flips it to "rows the AI did NOT mark". Resolves by source id.
  | { op: 'aimark'; exclude?: boolean }
  // A specific set of positional rowids — used to pivot the grid to EXACTLY a constellation event's
  // evidence rows (not a broad keyword). The rids are validated integers, so they bind safely.
  | { op: 'rids'; rids: number[] }

/** The source id of a workspace data table (`data_<id>` → id), or null for the legacy `data` table. */
function tableSourceId(table: string): number | null {
  const m = /^data_(\d+)$/.exec(table)
  return m ? Number(m[1]) : null
}

/** SQL expression turning a time column into epoch seconds, per its detected kind. */
function colTimeExpr(col: string, kind: TimeKind): string {
  if (kind === 'iso') return `unixepoch(${col})`
  if (kind === 'epoch_ms') return `(CAST(${col} AS INTEGER) / 1000)`
  return `CAST(${col} AS INTEGER)`
}

/** Same conversion for a bound value passed as a parameter. */
function valTimeExpr(kind: TimeKind): string {
  if (kind === 'iso') return `unixepoch(?)`
  if (kind === 'epoch_ms') return `(CAST(? AS INTEGER) / 1000)`
  return `CAST(? AS INTEGER)`
}

export interface Sort {
  col: string
  dir: 'asc' | 'desc'
  numeric?: boolean
}

export interface QueryOpts {
  sort?: Sort
  filters?: Filter[]
  /** Global quick-find term: matches any column (LIKE, ANDed with `filters`). */
  search?: string
  limit: number
  offset: number
}

/** Largest number of rows that fit one multi-row INSERT under SQLite's host-param limit. */
export function maxRowsPerInsert(numCols: number): number {
  return Math.max(1, Math.floor(HOST_PARAM_LIMIT / Math.max(1, numCols)))
}

export function buildCreateTable(cols: ColumnMap[], table = 'data'): string {
  assertTable(table)
  const defs = cols
    .map((c) => {
      assertCol(c.name)
      return `${c.name} TEXT`
    })
    .join(', ')
  return `CREATE TABLE ${table} (rowid INTEGER PRIMARY KEY, ${defs})`
}

export function buildInsertSql(cols: ColumnMap[], rowsInBatch: number, table = 'data'): string {
  assertTable(table)
  const names = cols
    .map((c) => {
      assertCol(c.name)
      return c.name
    })
    .join(', ')
  const oneRow = `(${cols.map(() => '?').join(', ')})`
  const values = Array(Math.max(1, rowsInBatch)).fill(oneRow).join(', ')
  return `INSERT INTO ${table} (${names}) VALUES ${values}`
}

function buildWhere(
  filters?: Filter[],
  search?: { term: string; cols: ColumnMap[] },
  table = 'data'
): { sql: string; params: (string | number)[] } {
  const clauses: string[] = []
  const params: (string | number)[] = []
  if (filters) {
    for (const f of filters) {
      // A tag filter isn't tied to a column — resolve it against the `tags` table by source id.
      // Matches rows carrying ANY of the chosen tags (OR via IN).
      if (f.op === 'tag') {
        if (f.tags.length === 0) continue // empty set → no constraint
        const sid = tableSourceId(table)
        if (sid == null) {
          if (!f.exclude) clauses.push('0') // legacy table has no tags → include matches nothing; exclude matches all
          continue
        }
        const placeholders = f.tags.map(() => '?').join(', ')
        clauses.push(`rowid ${f.exclude ? 'NOT IN' : 'IN'} (SELECT rid FROM tags WHERE source_id = ? AND tag IN (${placeholders}))`)
        params.push(sid, ...f.tags)
        continue
      }
      if (f.op === 'sighting') {
        const sid = tableSourceId(table)
        if (sid == null) {
          if (!f.exclude) clauses.push('0') // legacy table has no sightings → include matches nothing
          continue
        }
        const op = f.exclude ? 'NOT IN' : 'IN'
        if (f.indicators && f.indicators.length > 0) {
          const ph = f.indicators.map(() => '?').join(', ')
          clauses.push(`rowid ${op} (SELECT rid FROM intel_hits WHERE source_id = ? AND indicator IN (${ph}))`)
          params.push(sid, ...f.indicators)
        } else {
          clauses.push(`rowid ${op} (SELECT rid FROM intel_hits WHERE source_id = ?)`)
          params.push(sid)
        }
        continue
      }
      if (f.op === 'aimark') {
        const sid = tableSourceId(table)
        if (sid == null) {
          if (!f.exclude) clauses.push('0') // legacy table has no AI marks → include matches nothing
          continue
        }
        clauses.push(`rowid ${f.exclude ? 'NOT IN' : 'IN'} (SELECT rid FROM ai_marks WHERE source_id = ?)`)
        params.push(sid)
        continue
      }
      if (f.op === 'rids') {
        const ids = Array.isArray(f.rids) ? f.rids.filter((n) => Number.isInteger(n)) : []
        if (ids.length === 0) {
          clauses.push('0') // an explicit empty set matches nothing
          continue
        }
        clauses.push(`rowid IN (${ids.map(() => '?').join(', ')})`)
        params.push(...ids)
        continue
      }
      assertCol(f.col)
      if (f.op === 'like') {
        clauses.push(`${f.col} LIKE ? ESCAPE '\\'`)
        params.push(`%${escapeLike(f.value)}%`)
      } else if (f.op === 'nlike') {
        clauses.push(`${f.col} NOT LIKE ? ESCAPE '\\'`)
        params.push(`%${escapeLike(f.value)}%`)
      } else if (f.op === 'neq') {
        clauses.push(`${f.col} <> ?`)
        params.push(f.value)
      } else if (f.op === 'in') {
        if (f.values.length === 0) continue // an empty set adds no constraint
        clauses.push(`${f.col} IN (${f.values.map(() => '?').join(', ')})`)
        for (const v of f.values) params.push(v)
      } else if (f.op === 'timearound') {
        const colE = colTimeExpr(f.col, f.tkind)
        const valE = valTimeExpr(f.tkind)
        clauses.push(`${colE} BETWEEN (${valE}) - ? AND (${valE}) + ?`)
        params.push(f.value, f.deltaSec, f.value, f.deltaSec)
      } else if (f.op === 'timerange') {
        if (f.from == null && f.to == null) continue // no bound → no constraint
        const colE = colTimeExpr(f.col, f.tkind)
        if (f.from != null) {
          clauses.push(`${colE} >= ?`)
          params.push(f.from)
        }
        if (f.to != null) {
          clauses.push(`${colE} <= ?`)
          params.push(f.to)
        }
      } else {
        clauses.push(`${f.col} = ?`)
        params.push(f.value)
      }
    }
  }
  // A non-empty search term matches any column: (c0 LIKE ? OR c1 LIKE ? OR …), ANDed in.
  if (search && search.term !== '' && search.cols.length > 0) {
    const ors: string[] = []
    for (const c of search.cols) {
      assertCol(c.name)
      ors.push(`${c.name} LIKE ? ESCAPE '\\'`)
      params.push(`%${escapeLike(search.term)}%`)
    }
    clauses.push(`(${ors.join(' OR ')})`)
  }
  if (clauses.length === 0) return { sql: '', params: [] }
  return { sql: ` WHERE ${clauses.join(' AND ')}`, params }
}

/** Escape LIKE wildcards so a filter value is matched literally. */
function escapeLike(v: string): string {
  return v.replace(/[\\%_]/g, (m) => `\\${m}`)
}

export function buildQueryRowsSql(
  cols: ColumnMap[],
  o: QueryOpts,
  table = 'data',
  withRowid = false
): { sql: string; params: unknown[] } {
  assertTable(table)
  const cnames = cols
    .map((c) => {
      assertCol(c.name)
      return c.name
    })
    .join(', ')
  // When the caller needs each row's identity (tags, scroll-to-row), prepend the rowid as the
  // leading SELECT column. queryRows splits it off so the cell array stays exactly c0..cN.
  const names = withRowid ? `rowid, ${cnames}` : cnames
  const where = buildWhere(o.filters, o.search ? { term: o.search, cols } : undefined, table)
  let order = ''
  if (o.sort) {
    assertCol(o.sort.col)
    const dir = o.sort.dir === 'desc' ? 'DESC' : 'ASC'
    const expr = o.sort.numeric ? `CAST(${o.sort.col} AS REAL)` : `${o.sort.col} COLLATE NOCASE`
    order = ` ORDER BY ${expr} ${dir}`
  }
  const limit = clamp(o.limit, 0, MAX_ROWS_LIMIT)
  const offset = Math.max(0, Math.trunc(o.offset) || 0)
  // Keyset fast-path: with no WHERE and no ORDER BY the rows are in rowid order and rowids are a
  // gapless 1..N (sequential insert, no deletes), so ordinal position p == rowid - 1. Then
  // `WHERE rowid > offset LIMIT limit` returns exactly the same window as `LIMIT limit OFFSET
  // offset`, but seeks via the rowid primary key in O(log n) instead of walking `offset` rows —
  // turning deep-scroll/jump on a huge table from O(offset) (~0.45s at 12M) into O(1) (~0.2ms).
  // Filtered/sorted/searched views keep OFFSET (their result sets are smaller, and the
  // ordinal→rowid mapping no longer holds).
  if (where.sql === '' && order === '') {
    return { sql: `SELECT ${names} FROM ${table} WHERE rowid > ? LIMIT ?`, params: [offset, limit] }
  }
  const sql = `SELECT ${names} FROM ${table}${where.sql}${order} LIMIT ? OFFSET ?`
  return { sql, params: [...where.params, limit, offset] }
}

/** RFC-4180 escape one CSV field: quote it when it holds a comma, quote, CR or LF; double inner quotes. */
export function csvField(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

/** Join one row of values into a CSV line (no trailing newline), each field RFC-4180 escaped. */
export function csvRow(values: readonly string[]): string {
  return values.map(csvField).join(',')
}

/**
 * Select EVERY row matching the predicate (no LIMIT/OFFSET) in display order — for CSV export.
 * The caller iterates the statement and streams rows to a file, so the whole result set never
 * lives in memory at once. Same WHERE/ORDER BY semantics as `buildQueryRowsSql` (sans paging),
 * so an export matches exactly what the grid shows under the current filters + search + sort.
 */
export function buildExportSql(
  cols: ColumnMap[],
  o: { filters?: Filter[]; search?: string; sort?: Sort },
  table = 'data'
): { sql: string; params: unknown[] } {
  assertTable(table)
  const cnames = cols
    .map((c) => {
      assertCol(c.name)
      return c.name
    })
    .join(', ')
  const where = buildWhere(o.filters, o.search ? { term: o.search, cols } : undefined, table)
  let order = ''
  if (o.sort) {
    assertCol(o.sort.col)
    const dir = o.sort.dir === 'desc' ? 'DESC' : 'ASC'
    const expr = o.sort.numeric ? `CAST(${o.sort.col} AS REAL)` : `${o.sort.col} COLLATE NOCASE`
    order = ` ORDER BY ${expr} ${dir}`
  }
  return { sql: `SELECT ${cnames} FROM ${table}${where.sql}${order}`, params: where.params }
}

export function buildCountSql(
  cols: ColumnMap[],
  filters?: Filter[],
  search?: string,
  table = 'data'
): { sql: string; params: unknown[] } {
  assertTable(table)
  const where = buildWhere(filters, search ? { term: search, cols } : undefined, table)
  return { sql: `SELECT COUNT(*) AS n FROM ${table}${where.sql}`, params: where.params }
}

/**
 * Count matches within a rowid slice `(loExclusive, hiInclusive]`, ANDed with the predicate.
 * Used to count a filtered/searched result set in chunks so the main process can yield between
 * slices (stays responsive + cancelable) instead of one blocking full-table scan.
 */
export function buildCountChunkSql(
  cols: ColumnMap[],
  filters: Filter[] | undefined,
  search: string | undefined,
  loExclusive: number,
  hiInclusive: number,
  table = 'data'
): { sql: string; params: unknown[] } {
  assertTable(table)
  const where = buildWhere(filters, search ? { term: search, cols } : undefined, table)
  const extra = where.sql ? where.sql.replace(/^ WHERE /, ' AND ') : ''
  return {
    sql: `SELECT COUNT(*) AS n FROM ${table} WHERE rowid > ? AND rowid <= ?${extra}`,
    params: [loExclusive, hiInclusive, ...where.params]
  }
}

/**
 * Per-tab materialized filter index: a temp table holding the matching rowids of a filtered/
 * searched view, in rowid order. Its own (implicit) rowid is a gapless sequence, so paging it by
 * keyset gives O(1) random access into the filtered set — the same trick as the unfiltered view,
 * extended to filters. Built in rowid-chunk inserts (yielding between) so it doesn't block.
 */
export const FILT_TABLE = '_pl_filt'

export function buildFilterInsertChunkSql(
  cols: ColumnMap[],
  filters: Filter[] | undefined,
  search: string | undefined,
  loExclusive: number,
  hiInclusive: number,
  table = 'data',
  filtTable = FILT_TABLE
): { sql: string; params: unknown[] } {
  assertTable(table)
  assertFilt(filtTable)
  const where = buildWhere(filters, search ? { term: search, cols } : undefined, table)
  const extra = where.sql ? where.sql.replace(/^ WHERE /, ' AND ') : ''
  return {
    sql: `INSERT INTO ${filtTable} (rid) SELECT rowid FROM ${table} WHERE rowid > ? AND rowid <= ?${extra} ORDER BY rowid`,
    params: [loExclusive, hiInclusive, ...where.params]
  }
}

/** Keyset page over the materialized filter index, joined back to the data rows. */
export function buildFiltPageSql(
  cols: ColumnMap[],
  offset: number,
  limit: number,
  table = 'data',
  filtTable = FILT_TABLE,
  withRowid = false
): { sql: string; params: unknown[] } {
  assertTable(table)
  assertFilt(filtTable)
  const cnames = cols
    .map((c) => {
      assertCol(c.name)
      return `${table}.${c.name}`
    })
    .join(', ')
  const names = withRowid ? `${table}.rowid, ${cnames}` : cnames
  const lim = clamp(limit, 0, MAX_ROWS_LIMIT)
  const off = Math.max(0, Math.trunc(offset) || 0)
  // ORDER BY the index rowid (its gapless sequence) so the page is in result-set order — the grid
  // positions these rows at absolute offsets. It's a no-op cost: the WHERE already scans that PK.
  return {
    sql: `SELECT ${names} FROM ${filtTable} JOIN ${table} ON ${table}.rowid = ${filtTable}.rid WHERE ${filtTable}.rowid > ? ORDER BY ${filtTable}.rowid LIMIT ?`,
    params: [off, lim]
  }
}

/**
 * Bulk-tag every row matching the current view (filters + search) in one statement — the payoff
 * for tagging on large files, where hand-selecting the match set is impossible. Upserts so already-
 * tagged rows are re-tagged. `updatedAt` is passed in (sql.ts stays clock-free).
 */
export function buildTagApplyByFilterSql(
  cols: ColumnMap[],
  filters: Filter[] | undefined,
  search: string | undefined,
  sourceId: number,
  tag: string,
  updatedAt: number,
  table = 'data',
  actor: string | null = null
): { sql: string; params: unknown[] } {
  assertTable(table)
  const where = buildWhere(filters, search ? { term: search, cols } : undefined, table)
  // An INSERT…SELECT…FROM needs a WHERE before ON CONFLICT so the parser doesn't read ON as a join
  // (SQLite upsert rule); reuse the predicate, or `WHERE true` when tagging the whole table.
  const whereSql = where.sql || ' WHERE true'
  const sql =
    `INSERT INTO tags (source_id, rid, tag, updated_at, actor) SELECT ?, rowid, ?, ?, ? FROM ${table}${whereSql} ` +
    `ON CONFLICT(source_id, rid) DO UPDATE SET tag = excluded.tag, updated_at = excluded.updated_at, actor = excluded.actor`
  return { sql, params: [sourceId, tag, updatedAt, actor, ...where.params] }
}

/** Bulk AI-accountability mark every row matching the view, in one statement (the `ai_marks`
 *  dimension). Upserts the note. `createdAt` is passed in (sql.ts stays clock-free). */
export function buildAiMarkApplyByFilterSql(
  cols: ColumnMap[],
  filters: Filter[] | undefined,
  search: string | undefined,
  sourceId: number,
  note: string | null,
  createdAt: number,
  table = 'data'
): { sql: string; params: unknown[] } {
  assertTable(table)
  const where = buildWhere(filters, search ? { term: search, cols } : undefined, table)
  const whereSql = where.sql || ' WHERE true'
  const sql =
    `INSERT INTO ai_marks (source_id, rid, note, created_at) SELECT ?, rowid, ?, ? FROM ${table}${whereSql} ` +
    `ON CONFLICT(source_id, rid) DO UPDATE SET note = excluded.note, created_at = excluded.created_at`
  return { sql, params: [sourceId, note, createdAt, ...where.params] }
}

/** Clear the tag from every row matching the current view (filters + search). */
export function buildTagClearByFilterSql(
  cols: ColumnMap[],
  filters: Filter[] | undefined,
  search: string | undefined,
  sourceId: number,
  table = 'data'
): { sql: string; params: unknown[] } {
  assertTable(table)
  const where = buildWhere(filters, search ? { term: search, cols } : undefined, table)
  const sql = `DELETE FROM tags WHERE source_id = ? AND rid IN (SELECT rowid FROM ${table}${where.sql})`
  return { sql, params: [sourceId, ...where.params] }
}

/** SELECT rowid + the chosen columns over a rowid window (lo, hi] — the read side of an intel
 *  sweep, scanned in chunks. `columns` are c0..cN names (whitelisted); the caller passes ≥1. */
export function buildSweepScanSql(
  columns: string[],
  lo: number,
  hi: number,
  table = 'data'
): { sql: string; params: unknown[] } {
  assertTable(table)
  const names = columns
    .map((c) => {
      assertCol(c)
      return c
    })
    .join(', ')
  return { sql: `SELECT rowid, ${names} FROM ${table} WHERE rowid > ? AND rowid <= ?`, params: [lo, hi] }
}

/**
 * Per-tag row counts for the current view, EXCLUDING any tag filter from the predicate — so the
 * sidebar rollup stays a faceted total (toggling a tag filter doesn't zero out its siblings, and
 * you can still see/switch to other tags). Each row of the small `tags` table is probed against the
 * data table by rowid via EXISTS, so the cost scales with the number of tagged rows, not table size.
 * Returns null for the legacy single-file `data` table, which carries no tags.
 */
export function buildTagCountsSql(
  cols: ColumnMap[],
  filters: Filter[] | undefined,
  search: string | undefined,
  table = 'data'
): { sql: string; params: unknown[] } | null {
  assertTable(table)
  const sid = tableSourceId(table)
  if (sid == null) return null // legacy `data` table has no tags
  const nonTag = (filters ?? []).filter((f) => f.op !== 'tag')
  const where = buildWhere(nonTag, search ? { term: search, cols } : undefined, table)
  const params: unknown[] = [sid]
  let existsSql = ''
  if (where.sql !== '') {
    // where.sql is ' WHERE <pred>'. The non-tag predicate references only c0..cN columns, so it
    // resolves unambiguously inside an EXISTS over the data table, correlated by rowid.
    const pred = where.sql.replace(/^ WHERE /, '')
    existsSql = ` AND EXISTS (SELECT 1 FROM ${table} WHERE ${table}.rowid = t.rid AND ${pred})`
    params.push(...where.params)
  }
  const sql = `SELECT t.tag AS tag, COUNT(*) AS cnt FROM tags t WHERE t.source_id = ?${existsSql} GROUP BY t.tag`
  return { sql, params }
}

/**
 * One rowid slice of a column's distinct values + per-slice counts, ANDed with the predicate.
 * Driving distinct in chunks (merging the per-slice counts in JS) keeps the worker responsive +
 * cancelable and streams progress, instead of one blocking GROUP BY over the whole column.
 */
export function buildDistinctChunkSql(
  col: string,
  filters: Filter[] | undefined,
  loExclusive: number,
  hiInclusive: number,
  table = 'data'
): { sql: string; params: unknown[] } {
  assertTable(table)
  assertCol(col)
  const where = buildWhere(filters, undefined, table)
  const extra = where.sql ? where.sql.replace(/^ WHERE /, ' AND ') : ''
  return {
    sql: `SELECT ${col} AS val, COUNT(*) AS cnt FROM ${table} WHERE rowid > ? AND rowid <= ?${extra} GROUP BY ${col}`,
    params: [loExclusive, hiInclusive, ...where.params]
  }
}

/** How a time column is bucketed for a histogram (strftime format applied to epoch seconds). */
export type TimeBucket = 'minute' | 'hour' | 'day' | 'month' | 'year' | 'hourofday' | 'dayofweek'
const BUCKET_FMT: Record<TimeBucket, string> = {
  minute: '%Y-%m-%dT%H:%M',
  hour: '%Y-%m-%dT%H:00',
  day: '%Y-%m-%d',
  month: '%Y-%m',
  year: '%Y',
  hourofday: '%H', // 00..23 — "how many per hour of the day"
  dayofweek: '%w' // 0=Sunday..6 — "how many per weekday"
}

/** The GROUP BY expression for a column: the raw column, or a time-bucket label when `bucket` is set
 *  and the column is a known time column. */
function groupExpr(col: string, kind: TimeKind | null | undefined, bucket?: TimeBucket): string {
  if (bucket && kind) return `strftime('${BUCKET_FMT[bucket]}', ${colTimeExpr(col, kind)}, 'unixepoch')`
  return col
}

/**
 * Aggregate (GROUP BY … COUNT) over a column — a histogram / distribution in one query instead of N.
 * Optionally: bucket a time column (hour/day/…), cross-tabulate against a second column (`by` → a 2-D
 * pivot), and restrict with the same filter/search grammar as the row query. Ordered by count desc by
 * default, or by the bucket value ascending (`order: 'value'`) for a chronological time histogram.
 */
export function buildAggregateSql(
  cols: ColumnMap[],
  opts: {
    col: string
    colKind?: TimeKind | null
    by?: string
    byKind?: TimeKind | null
    bucket?: TimeBucket
    filters?: Filter[]
    search?: string
    limit: number
    order: 'count' | 'value'
  },
  table = 'data'
): { sql: string; params: (string | number)[] } {
  assertTable(table)
  assertCol(opts.col)
  if (opts.by) assertCol(opts.by)
  const gExpr = groupExpr(opts.col, opts.colKind, opts.bucket)
  const bExpr = opts.by ? groupExpr(opts.by, opts.byKind, opts.bucket) : null
  const where = buildWhere(opts.filters, opts.search ? { term: opts.search, cols } : undefined, table)
  const selects = [`${gExpr} AS gv`]
  const groupBys = ['gv']
  if (bExpr) {
    selects.push(`${bExpr} AS bv`)
    groupBys.push('bv')
  }
  selects.push('COUNT(*) AS n')
  const orderBy = opts.order === 'value' ? 'gv ASC' + (bExpr ? ', bv ASC' : '') : 'n DESC, gv ASC'
  const sql = `SELECT ${selects.join(', ')} FROM ${table}${where.sql} GROUP BY ${groupBys.join(', ')} ORDER BY ${orderBy} LIMIT ?`
  return { sql, params: [...where.params, opts.limit] }
}

/**
 * How many DISTINCT buckets the same aggregate would produce, ignoring the limit — so a truncated
 * result can report "20 of 67" instead of just `truncated: true` (which leaves the caller unable to
 * tell whether it saw nearly everything or a small slice).
 */
export function buildAggregateCountSql(
  cols: ColumnMap[],
  opts: { col: string; colKind?: TimeKind | null; by?: string; byKind?: TimeKind | null; bucket?: TimeBucket; filters?: Filter[]; search?: string },
  table = 'data'
): { sql: string; params: (string | number)[] } {
  assertTable(table)
  assertCol(opts.col)
  if (opts.by) assertCol(opts.by)
  const gExpr = groupExpr(opts.col, opts.colKind, opts.bucket)
  const bExpr = opts.by ? groupExpr(opts.by, opts.byKind, opts.bucket) : null
  const where = buildWhere(opts.filters, opts.search ? { term: opts.search, cols } : undefined, table)
  const selects = [`${gExpr} AS gv`, ...(bExpr ? [`${bExpr} AS bv`] : [])]
  const groupBys = ['gv', ...(bExpr ? ['bv'] : [])]
  const inner = `SELECT ${selects.join(', ')} FROM ${table}${where.sql} GROUP BY ${groupBys.join(', ')}`
  return { sql: `SELECT COUNT(*) AS n FROM (${inner})`, params: where.params }
}

/** The longest value in a column (for auto-fit column width), truncated to `cap` chars. */
export function buildLongestSql(col: string, cap = 256, table = 'data'): { sql: string; params: unknown[] } {
  assertTable(table)
  assertCol(col)
  return {
    sql: `SELECT SUBSTR(${col}, 1, ?) AS val FROM ${table} ORDER BY LENGTH(${col}) DESC LIMIT 1`,
    params: [clamp(cap, 1, 4096)]
  }
}

export function buildColumnValuesSql(
  col: string,
  filters?: Filter[],
  cap = VALUES_CAP,
  table = 'data'
): { sql: string; params: unknown[] } {
  assertTable(table)
  assertCol(col)
  const where = buildWhere(filters, undefined, table)
  const lim = clamp(cap, 1, VALUES_CAP)
  return { sql: `SELECT ${col} AS val FROM ${table}${where.sql} LIMIT ?`, params: [...where.params, lim] }
}

export function buildStatsSql(col: string, table = 'data'): { sql: string; params: unknown[] } {
  assertTable(table)
  assertCol(col)
  const sql =
    `SELECT COUNT(*) AS count,` +
    ` SUM(CASE WHEN ${col} IS NULL OR ${col} = '' THEN 1 ELSE 0 END) AS nullCount,` +
    ` COUNT(DISTINCT ${col}) AS distinct_` +
    ` FROM ${table}`
  return { sql, params: [] }
}

/**
 * MIN/MAX of a time column, for explaining an empty time-filtered result.
 *
 * Epoch columns are stored as TEXT, so a plain MIN/MAX would compare them lexically ("9" > "10") and
 * report a range that never happened. CAST makes the comparison numeric for those kinds; ISO text
 * sorts chronologically already. Empty cells are excluded so a sparse column reports the span of the
 * values it actually has.
 */
export function buildTimeRangeSql(col: string, tkind: TimeKind, table = 'data'): { sql: string; params: unknown[] } {
  assertTable(table)
  assertCol(col)
  const v = tkind === 'iso' ? col : `CAST(${col} AS INTEGER)`
  const sql = `SELECT MIN(${v}) AS lo, MAX(${v}) AS hi FROM ${table} WHERE ${col} IS NOT NULL AND ${col} <> ''`
  return { sql, params: [] }
}

function clamp(n: number, lo: number, hi: number): number {
  const v = Math.trunc(n) || 0
  return Math.min(Math.max(v, lo), hi)
}
