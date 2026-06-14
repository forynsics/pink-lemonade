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

export const HOST_PARAM_LIMIT = 32766
export const MAX_ROWS_LIMIT = 10_000
export const DISTINCT_CAP = 100_000
export const VALUES_CAP = 1_000_000

// A row filter is one of:
//  • single-value predicate (equals / contains)
//  • multi-value set membership (`in`) — one chip holding several values for a column
//  • `timearound` — rows whose (epoch-normalised) time column is within ±deltaSec of `value`
export type Filter =
  | { col: string; op: 'eq' | 'like' | 'neq'; value: string }
  | { col: string; op: 'in'; values: string[] }
  | { col: string; op: 'timearound'; value: string; tkind: TimeKind; deltaSec: number }
  // Open/closed range on a time column in epoch seconds: from→`>=`, to→`<=`, both→between.
  | { col: string; op: 'timerange'; tkind: TimeKind; from?: number; to?: number }

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

export function buildCreateTable(cols: ColumnMap[]): string {
  const defs = cols
    .map((c) => {
      assertCol(c.name)
      return `${c.name} TEXT`
    })
    .join(', ')
  return `CREATE TABLE data (rowid INTEGER PRIMARY KEY, ${defs})`
}

export function buildInsertSql(cols: ColumnMap[], rowsInBatch: number): string {
  const names = cols
    .map((c) => {
      assertCol(c.name)
      return c.name
    })
    .join(', ')
  const oneRow = `(${cols.map(() => '?').join(', ')})`
  const values = Array(Math.max(1, rowsInBatch)).fill(oneRow).join(', ')
  return `INSERT INTO data (${names}) VALUES ${values}`
}

function buildWhere(
  filters?: Filter[],
  search?: { term: string; cols: ColumnMap[] }
): { sql: string; params: (string | number)[] } {
  const clauses: string[] = []
  const params: (string | number)[] = []
  if (filters) {
    for (const f of filters) {
      assertCol(f.col)
      if (f.op === 'like') {
        clauses.push(`${f.col} LIKE ? ESCAPE '\\'`)
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

export function buildQueryRowsSql(cols: ColumnMap[], o: QueryOpts): { sql: string; params: unknown[] } {
  const names = cols
    .map((c) => {
      assertCol(c.name)
      return c.name
    })
    .join(', ')
  const where = buildWhere(o.filters, o.search ? { term: o.search, cols } : undefined)
  let order = ''
  if (o.sort) {
    assertCol(o.sort.col)
    const dir = o.sort.dir === 'desc' ? 'DESC' : 'ASC'
    const expr = o.sort.numeric ? `CAST(${o.sort.col} AS REAL)` : `${o.sort.col} COLLATE NOCASE`
    order = ` ORDER BY ${expr} ${dir}`
  }
  const limit = clamp(o.limit, 0, MAX_ROWS_LIMIT)
  const offset = Math.max(0, Math.trunc(o.offset) || 0)
  const sql = `SELECT ${names} FROM data${where.sql}${order} LIMIT ? OFFSET ?`
  return { sql, params: [...where.params, limit, offset] }
}

export function buildCountSql(
  cols: ColumnMap[],
  filters?: Filter[],
  search?: string
): { sql: string; params: unknown[] } {
  const where = buildWhere(filters, search ? { term: search, cols } : undefined)
  return { sql: `SELECT COUNT(*) AS n FROM data${where.sql}`, params: where.params }
}

export function buildDistinctSql(
  col: string,
  filters: Filter[] | undefined,
  limit: number
): { sql: string; params: unknown[] } {
  assertCol(col)
  const where = buildWhere(filters)
  const lim = clamp(limit, 1, DISTINCT_CAP)
  const sql =
    `SELECT ${col} AS val, COUNT(*) AS cnt FROM data${where.sql}` +
    ` GROUP BY ${col} ORDER BY cnt DESC, val ASC LIMIT ?`
  return { sql, params: [...where.params, lim] }
}

/** True number of distinct values in a column (honours filters) — not capped by the list limit. */
export function buildDistinctCountSql(col: string, filters?: Filter[]): { sql: string; params: unknown[] } {
  assertCol(col)
  const where = buildWhere(filters)
  return { sql: `SELECT COUNT(DISTINCT ${col}) AS n FROM data${where.sql}`, params: where.params }
}

/** The longest value in a column (for auto-fit column width), truncated to `cap` chars. */
export function buildLongestSql(col: string, cap = 256): { sql: string; params: unknown[] } {
  assertCol(col)
  return {
    sql: `SELECT SUBSTR(${col}, 1, ?) AS val FROM data ORDER BY LENGTH(${col}) DESC LIMIT 1`,
    params: [clamp(cap, 1, 4096)]
  }
}

export function buildColumnValuesSql(
  col: string,
  filters?: Filter[],
  cap = VALUES_CAP
): { sql: string; params: unknown[] } {
  assertCol(col)
  const where = buildWhere(filters)
  const lim = clamp(cap, 1, VALUES_CAP)
  return { sql: `SELECT ${col} AS val FROM data${where.sql} LIMIT ?`, params: [...where.params, lim] }
}

export function buildStatsSql(col: string): { sql: string; params: unknown[] } {
  assertCol(col)
  const sql =
    `SELECT COUNT(*) AS count,` +
    ` SUM(CASE WHEN ${col} IS NULL OR ${col} = '' THEN 1 ELSE 0 END) AS nullCount,` +
    ` COUNT(DISTINCT ${col}) AS distinct_` +
    ` FROM data`
  return { sql, params: [] }
}

function clamp(n: number, lo: number, hi: number): number {
  const v = Math.trunc(n) || 0
  return Math.min(Math.max(v, lo), hi)
}
