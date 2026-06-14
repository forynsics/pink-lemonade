import { describe, it, expect } from 'vitest'
import {
  maxRowsPerInsert,
  buildCreateTable,
  buildInsertSql,
  buildQueryRowsSql,
  buildCountSql,
  buildDistinctSql,
  buildDistinctCountSql,
  buildLongestSql,
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

  it('renders a `neq` (exclude) filter as <> ?', () => {
    const { sql, params } = buildQueryRowsSql(cols, {
      limit: 10,
      offset: 0,
      filters: [{ col: 'c1', op: 'neq', value: 'HackTool' }]
    })
    expect(sql).toBe('SELECT c0, c1 FROM data WHERE c1 <> ? LIMIT ? OFFSET ?')
    expect(params).toEqual(['HackTool', 10, 0])
  })

  it('renders a multi-value `in` filter as one IN (...) clause with bound params', () => {
    const { sql, params } = buildQueryRowsSql(cols, {
      limit: 100,
      offset: 0,
      filters: [{ col: 'c0', op: 'in', values: ['1.1.1.1', '8.8.8.8', '9.9.9.9'] }]
    })
    expect(sql).toBe('SELECT c0, c1 FROM data WHERE c0 IN (?, ?, ?) LIMIT ? OFFSET ?')
    expect(params).toEqual(['1.1.1.1', '8.8.8.8', '9.9.9.9', 100, 0])
  })

  it('renders a `timearound` ISO filter via unixepoch ± delta', () => {
    const { sql, params } = buildQueryRowsSql(cols, {
      limit: 100,
      offset: 0,
      filters: [{ col: 'c0', op: 'timearound', value: '2026-06-13T21:14:00Z', tkind: 'iso', deltaSec: 300 }]
    })
    expect(sql).toBe(
      'SELECT c0, c1 FROM data WHERE unixepoch(c0) BETWEEN (unixepoch(?)) - ? AND (unixepoch(?)) + ? LIMIT ? OFFSET ?'
    )
    expect(params).toEqual(['2026-06-13T21:14:00Z', 300, '2026-06-13T21:14:00Z', 300, 100, 0])
  })

  it('renders a `timearound` epoch_ms filter dividing by 1000', () => {
    const { sql } = buildQueryRowsSql(cols, {
      limit: 10,
      offset: 0,
      filters: [{ col: 'c0', op: 'timearound', value: '1718313258123', tkind: 'epoch_ms', deltaSec: 60 }]
    })
    expect(sql).toContain('(CAST(c0 AS INTEGER) / 1000) BETWEEN ((CAST(? AS INTEGER) / 1000)) - ? AND')
  })

  it('renders `timerange` bounds as >= / <= on the epoch expression', () => {
    const gte = buildQueryRowsSql(cols, { limit: 5, offset: 0, filters: [{ col: 'c0', op: 'timerange', tkind: 'iso', from: 100 }] })
    expect(gte.sql).toBe('SELECT c0, c1 FROM data WHERE unixepoch(c0) >= ? LIMIT ? OFFSET ?')
    expect(gte.params).toEqual([100, 5, 0])

    const between = buildQueryRowsSql(cols, {
      limit: 5,
      offset: 0,
      filters: [{ col: 'c0', op: 'timerange', tkind: 'epoch_s', from: 100, to: 200 }]
    })
    expect(between.sql).toBe('SELECT c0, c1 FROM data WHERE CAST(c0 AS INTEGER) >= ? AND CAST(c0 AS INTEGER) <= ? LIMIT ? OFFSET ?')
    expect(between.params).toEqual([100, 200, 5, 0])
  })

  it('drops a `timerange` with no bounds', () => {
    expect(buildQueryRowsSql(cols, { limit: 5, offset: 0, filters: [{ col: 'c0', op: 'timerange', tkind: 'iso' }] }).sql).toBe(
      'SELECT c0, c1 FROM data LIMIT ? OFFSET ?'
    )
  })

  it('drops an empty `in` filter (no constraint)', () => {
    expect(buildQueryRowsSql(cols, { limit: 10, offset: 0, filters: [{ col: 'c0', op: 'in', values: [] }] }).sql).toBe(
      'SELECT c0, c1 FROM data LIMIT ? OFFSET ?'
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

  it('distinct count: COUNT(DISTINCT col), honouring filters', () => {
    expect(buildDistinctCountSql('c0').sql).toBe('SELECT COUNT(DISTINCT c0) AS n FROM data')
    const { sql, params } = buildDistinctCountSql('c0', [{ col: 'c1', op: 'eq', value: 'US' }])
    expect(sql).toBe('SELECT COUNT(DISTINCT c0) AS n FROM data WHERE c1 = ?')
    expect(params).toEqual(['US'])
  })

  it('longest: orders by LENGTH desc and truncates with SUBSTR', () => {
    const { sql, params } = buildLongestSql('c0')
    expect(sql).toBe('SELECT SUBSTR(c0, 1, ?) AS val FROM data ORDER BY LENGTH(c0) DESC LIMIT 1')
    expect(params).toEqual([256])
  })

  it('column values respects filters', () => {
    const { sql, params } = buildColumnValuesSql('c0', [{ col: 'c1', op: 'eq', value: 'US' }], 1000)
    expect(sql).toBe('SELECT c0 AS val FROM data WHERE c1 = ? LIMIT ?')
    expect(params).toEqual(['US', 1000])
  })

  it('count and stats', () => {
    expect(buildCountSql(cols).sql).toBe('SELECT COUNT(*) AS n FROM data')
    expect(buildStatsSql('c1').sql).toContain('COUNT(DISTINCT c1) AS distinct_')
  })
})

describe('global search', () => {
  it('rows: ORs the term across every column, ANDed with filters, escaped + bound', () => {
    const { sql, params } = buildQueryRowsSql(cols, {
      limit: 50,
      offset: 0,
      filters: [{ col: 'c1', op: 'eq', value: 'US' }],
      search: '10.0%'
    })
    expect(sql).toBe(
      "SELECT c0, c1 FROM data WHERE c1 = ? AND (c0 LIKE ? ESCAPE '\\' OR c1 LIKE ? ESCAPE '\\') LIMIT ? OFFSET ?"
    )
    expect(params).toEqual(['US', '%10.0\\%%', '%10.0\\%%', 50, 0])
  })

  it('count: applies the same all-column search predicate', () => {
    const { sql, params } = buildCountSql(cols, undefined, '185.220')
    expect(sql).toBe("SELECT COUNT(*) AS n FROM data WHERE (c0 LIKE ? ESCAPE '\\' OR c1 LIKE ? ESCAPE '\\')")
    expect(params).toEqual(['%185.220%', '%185.220%'])
  })

  it('an empty search term adds no predicate', () => {
    expect(buildQueryRowsSql(cols, { limit: 10, offset: 0, search: '' }).sql).toBe(
      'SELECT c0, c1 FROM data LIMIT ? OFFSET ?'
    )
    expect(buildCountSql(cols, undefined, '').sql).toBe('SELECT COUNT(*) AS n FROM data')
  })
})

describe('SQL-injection boundary', () => {
  const evil = 'c0); DROP TABLE data;--'
  it('rejects non c0..cN column identifiers everywhere', () => {
    expect(() => buildQueryRowsSql(cols, { limit: 1, offset: 0, sort: { col: evil, dir: 'asc' } })).toThrow(
      /Invalid column/
    )
    expect(() => buildDistinctSql(evil, undefined, 10)).toThrow(/Invalid column/)
    expect(() => buildDistinctCountSql(evil)).toThrow(/Invalid column/)
    expect(() => buildLongestSql(evil)).toThrow(/Invalid column/)
    expect(() => buildColumnValuesSql(evil)).toThrow(/Invalid column/)
    expect(() => buildStatsSql(evil)).toThrow(/Invalid column/)
    expect(() =>
      buildQueryRowsSql(cols, { limit: 1, offset: 0, filters: [{ col: evil, op: 'eq', value: 'x' }] })
    ).toThrow(/Invalid column/)
  })
})
