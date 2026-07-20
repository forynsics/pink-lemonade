import { describe, it, expect } from 'vitest'
import { checkAgentSql, stripLiterals } from './sqlGuard'

const ok = (sql: string): boolean => checkAgentSql(sql).ok
const why = (sql: string): string => checkAgentSql(sql).reason ?? ''

describe('stripLiterals', () => {
  // If this is wrong the guard is theatre: a keyword inside a quoted value would trip it, and a
  // keyword hidden by a comment would slip past.
  it('removes single-quoted strings', () => {
    expect(stripLiterals("SELECT * FROM t WHERE p LIKE '%attach%'")).not.toMatch(/attach/i)
  })

  it('removes double-quoted and bracketed identifiers', () => {
    expect(stripLiterals('SELECT "drop", [delete] FROM t')).not.toMatch(/drop|delete/i)
  })

  it('removes line and block comments', () => {
    expect(stripLiterals('SELECT 1 -- attach\nFROM t')).not.toMatch(/attach/i)
    expect(stripLiterals('SELECT /* pragma */ 1 FROM t')).not.toMatch(/pragma/i)
  })

  it('handles a doubled quote inside a string', () => {
    expect(stripLiterals("SELECT 'it''s attached' FROM t")).not.toMatch(/attach/i)
  })

  it('keeps the surrounding structure intact', () => {
    expect(stripLiterals("SELECT a FROM t WHERE b='x'").toLowerCase()).toContain('select')
    expect(stripLiterals("SELECT a FROM t WHERE b='x'").toLowerCase()).toContain('from')
  })
})

describe('checkAgentSql — what is allowed', () => {
  it('accepts a plain SELECT', () => {
    expect(ok('SELECT c0, c1 FROM data_0 LIMIT 10')).toBe(true)
  })

  it('accepts a WITH … SELECT', () => {
    expect(ok('WITH x AS (SELECT c0 FROM data_0) SELECT * FROM x')).toBe(true)
  })

  it('accepts a UNION across sources — the cross-source query this exists for', () => {
    expect(ok("SELECT rowid, c0 FROM data_0 UNION ALL SELECT rowid, c0 FROM data_1 ORDER BY c0")).toBe(true)
  })

  it('accepts a JOIN and aggregate', () => {
    expect(ok('SELECT a.c0, COUNT(*) FROM data_0 a JOIN data_1 b ON a.c1 = b.c1 GROUP BY a.c0')).toBe(true)
  })

  it('accepts a trailing semicolon', () => {
    expect(ok('SELECT 1 FROM data_0;')).toBe(true)
  })

  // The reason literals are stripped: these are ordinary forensic queries.
  it('accepts a value that merely contains a forbidden word', () => {
    expect(ok("SELECT * FROM data_0 WHERE c3 LIKE '%attach%'")).toBe(true)
    expect(ok("SELECT * FROM data_0 WHERE c3 = 'DROP TABLE'")).toBe(true)
  })
})

describe('checkAgentSql — what is refused', () => {
  it('refuses ATTACH, which read-only does NOT contain', () => {
    expect(ok("ATTACH DATABASE 'other.workspace' AS o")).toBe(false)
    // Also when smuggled after a legitimate-looking prefix.
    expect(ok("SELECT 1; ATTACH DATABASE 'x' AS o")).toBe(false)
    expect(why("ATTACH DATABASE 'x' AS o")).toMatch(/another database file/i)
  })

  it('refuses multiple statements', () => {
    expect(ok('SELECT 1 FROM data_0; SELECT 2 FROM data_1')).toBe(false)
    expect(why('SELECT 1; SELECT 2')).toMatch(/ONE statement/i)
  })

  it('refuses writes even though the connection is read-only', () => {
    for (const s of [
      "INSERT INTO data_0 VALUES ('x')",
      "UPDATE data_0 SET c0 = 'x'",
      'DELETE FROM data_0',
      'DROP TABLE data_0',
      'ALTER TABLE data_0 RENAME TO t',
      'CREATE TABLE t (a)'
    ]) {
      expect(ok(s), s).toBe(false)
    }
  })

  it('refuses PRAGMA and VACUUM', () => {
    expect(ok('PRAGMA table_info(data_0)')).toBe(false)
    expect(ok('VACUUM')).toBe(false)
  })

  // The table-valued FUNCTION form tokenizes as one `pragma_x` word, so the exact-word `pragma`
  // rule misses it — a real gap until it was closed. These are read-only reflection, but they
  // expose engine internals, which is exactly what the PRAGMA rule is there to forbid.
  it('refuses the pragma_* table-valued function forms', () => {
    expect(ok("SELECT * FROM pragma_table_info('data_0')")).toBe(false)
    expect(ok('SELECT * FROM pragma_database_list')).toBe(false)
    expect(ok('SELECT name FROM pragma_function_list')).toBe(false)
    expect(ok('SELECT * FROM pragma_compile_options')).toBe(false)
  })

  // …but a value that merely contains the substring is fine (literals are stripped before the check).
  it('still allows a query whose DATA contains "pragma"', () => {
    expect(ok("SELECT c0 FROM data_0 WHERE c1 LIKE '%pragma_table_info%'")).toBe(true)
  })

  it('refuses transaction control', () => {
    expect(ok('BEGIN')).toBe(false)
    expect(ok('SELECT 1 FROM data_0 UNION SELECT 2; COMMIT')).toBe(false)
  })

  it('refuses a write hidden inside a CTE', () => {
    // WITH-prefixed writes are real SQLite syntax; the keyword scan catches them.
    expect(ok('WITH x AS (SELECT 1) DELETE FROM data_0')).toBe(false)
  })

  it('refuses empty or comment-only input', () => {
    expect(ok('')).toBe(false)
    expect(ok('   ')).toBe(false)
    expect(ok('-- just a comment')).toBe(false)
    expect(why('-- just a comment')).toMatch(/no sql statement/i)
  })

  it('names what it found when the statement is not a SELECT', () => {
    expect(why('EXPLAIN SELECT 1')).toMatch(/starts with "explain"/i)
  })
})
