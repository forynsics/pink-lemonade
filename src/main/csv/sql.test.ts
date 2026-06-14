import { describe, it, expect } from 'vitest'
import {
  maxRowsPerInsert,
  buildCreateTable,
  buildInsertSql,
  buildQueryRowsSql,
  buildCountSql,
  buildDistinctSql,
  buildColumnValuesSql,
  buildStatsSql,
  HOST_PARAM_LIMIT,
  MAX_ROWS_LIMIT
} from './sql'
import type { ColumnMap } from './sanitize'

const cols: ColumnMap[] = [
  { name: 'c0', original: 'source.ip' },
  { name: 'c1', original: 'country' }
]

describe('maxRowsPerInsert', () => {
  it('respects the 32766 host-param limit', () => {
    expect(maxRowsPerInsert(2)).toBe(Math.floor(HOST_PARAM_LIMIT / 2))
    expect(maxRowsPerInsert(33000)).toBe(1) // never below 1
    expect(maxRowsPerInsert(0)).toBe(HOST_PARAM_LIMIT) // guards divide-by-zero
  })
})

describe('buildCreateTable / buildInsertSql', () => {
  it('creates an all-TEXT table with a rowid pk', () => {
    expect(buildCreateTable(cols)).toBe('CREATE TABLE data (rowid INTEGER PRIMARY KEY, c0 TEXT, c1 TEXT)')
  })

  it('builds a multi-row INSERT with the right placeholder count', () => {
    const sql = buildInsertSql(cols, 3)
    expect(sql).toBe('INSERT INTO data (c0, c1) VALUES (?, ?), (?, ?), (?, ?)')
    expect((sql.match(/\?/g) ?? []).length).toBe(6)
  })
})

describe('buildQueryRowsSql', () => {
  it('selects columns with LIMIT/OFFSET and caps the limit', () => {
    const { sql, params } = buildQueryRowsSql(cols, { limit: 999_999, offset: 40 })
    expect(sql).toBe('SELECT c0, c1 FROM data LIMIT ? OFFSET ?')
    expect(params).toEqual([MAX_ROWS_LIMIT, 40])
  })

  it('sorts numerically with CAST and text with COLLATE NOCASE', () => {
    expect(buildQueryRowsSql(cols, { limit: 10, offset: 0, sort: { col: 'c0', dir: 'desc', numeric: true } }).sql).toContain(
      'ORDER BY CAST(c0 AS REAL) DESC'
    )
    expect(buildQueryRowsSql(cols, { limit: 10, offset: 0, sort: { col: 'c1', dir: 'asc' } }).sql).toContain(
      'ORDER BY c1 COLLATE NOCASE ASC'
    )
  })

  it('binds filter values as params (eq and escaped like)', () => {
    const { sql, params } = buildQueryRowsSql(cols, {
      limit: 100,
      offset: 0,
      filters: [
        { col: 'c1', op: 'eq', value: 'US' },
        { col: 'c0', op: 'like', value: '10.0%_' }
      ]
    })
    expect(sql).toBe("SELECT c0, c1 FROM data WHERE c1 = ? AND c0 LIKE ? ESCAPE '\\' LIMIT ? OFFSET ?")
    expect(params).toEqual(['US', '%10.0\\%\\_%', 100, 0])
  })
})

describe('drill-down builders', () => {
  it('distinct: GROUP BY col ORDER BY cnt DESC', () => {
    const { sql, params } = buildDistinctSql('c0', undefined, 50)
    expect(sql).toBe('SELECT c0 AS val, COUNT(*) AS cnt FROM data GROUP BY c0 ORDER BY cnt DESC, val ASC LIMIT ?')
    expect(params).toEqual([50])
  })

  it('column values respects filters', () => {
    const { sql, params } = buildColumnValuesSql('c0', [{ col: 'c1', op: 'eq', value: 'US' }], 1000)
    expect(sql).toBe('SELECT c0 AS val FROM data WHERE c1 = ? LIMIT ?')
    expect(params).toEqual(['US', 1000])
  })

  it('count and stats', () => {
    expect(buildCountSql().sql).toBe('SELECT COUNT(*) AS n FROM data')
    expect(buildStatsSql('c1').sql).toContain('COUNT(DISTINCT c1) AS distinct_')
  })
})

describe('SQL-injection boundary', () => {
  const evil = 'c0); DROP TABLE data;--'
  it('rejects non c0..cN column identifiers everywhere', () => {
    expect(() => buildQueryRowsSql(cols, { limit: 1, offset: 0, sort: { col: evil, dir: 'asc' } })).toThrow(
      /Invalid column/
    )
    expect(() => buildDistinctSql(evil, undefined, 10)).toThrow(/Invalid column/)
    expect(() => buildColumnValuesSql(evil)).toThrow(/Invalid column/)
    expect(() => buildStatsSql(evil)).toThrow(/Invalid column/)
    expect(() =>
      buildQueryRowsSql(cols, { limit: 1, offset: 0, filters: [{ col: evil, op: 'eq', value: 'x' }] })
    ).toThrow(/Invalid column/)
  })
})
