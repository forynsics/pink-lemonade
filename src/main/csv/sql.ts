// Pure SQL builders for the CSV table — no better-sqlite3 import, fully unit-testable.
//
// Column identifiers are ALWAYS the positional `c0..cN` names (never user text); assertCol
// whitelists them, so column names can be interpolated safely while all *values* are bound
// as parameters. This is the single SQL-injection boundary.

import type { ColumnMap } from './sanitize'

const COL_RE = /^c\d+$/
function assertCol(name: string): void {
  if (!COL_RE.test(name)) throw new Error(`Invalid column identifier: ${JSON.stringify(name)}`)
}

export const HOST_PARAM_LIMIT = 32766
export const MAX_ROWS_LIMIT = 10_000
export const DISTINCT_CAP = 100_000
export const VALUES_CAP = 1_000_000

export interface Filter {
  col: string
  op: 'eq' | 'like'
  value: string
}

export interface Sort {
  col: string
  dir: 'asc' | 'desc'
  numeric?: boolean
}

export interface QueryOpts {
  sort?: Sort
  filters?: Filter[]
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

function buildWhere(filters?: Filter[]): { sql: string; params: string[] } {
  if (!filters || filters.length === 0) return { sql: '', params: [] }
  const clauses: string[] = []
  const params: string[] = []
  for (const f of filters) {
    assertCol(f.col)
    if (f.op === 'like') {
      clauses.push(`${f.col} LIKE ? ESCAPE '\\'`)
      params.push(`%${escapeLike(f.value)}%`)
    } else {
      clauses.push(`${f.col} = ?`)
      params.push(f.value)
    }
  }
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
  const where = buildWhere(o.filters)
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

export function buildCountSql(filters?: Filter[]): { sql: string; params: unknown[] } {
  const where = buildWhere(filters)
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
