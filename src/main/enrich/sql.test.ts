import { describe, expect, it } from 'vitest'
import { buildCacheGetSql, buildCacheGetAllSql, buildCacheDeleteSql, CREATE_ENRICHMENT_TABLE, CACHE_PUT_SQL } from './sql'

describe('enrich/sql', () => {
  it('builds an IN clause with one placeholder per indicator (plus the provider bind)', () => {
    const sql = buildCacheGetSql(3)
    expect(sql).toContain('provider = ?')
    expect(sql.match(/\?/g)).toHaveLength(4) // 1 provider + 3 indicators
    expect(sql).toContain('IN (?, ?, ?)')
  })

  it('rejects a non-positive count (an empty IN () is invalid SQL — caller must short-circuit)', () => {
    expect(() => buildCacheGetSql(0)).toThrow()
    expect(() => buildCacheGetSql(-1)).toThrow()
  })

  it('builds a cross-provider get with one placeholder per indicator (no provider bind)', () => {
    const sql = buildCacheGetAllSql(2)
    expect(sql).not.toContain('provider = ?')
    expect(sql.match(/\?/g)).toHaveLength(2)
    expect(sql).toContain('IN (?, ?)')
  })

  it('builds a delete-by-indicator with one placeholder per indicator', () => {
    const sql = buildCacheDeleteSql(2)
    expect(sql).toContain('DELETE FROM enrichment WHERE indicator IN (?, ?)')
    expect(() => buildCacheDeleteSql(0)).toThrow()
  })

  it('keys the table + upsert on (provider, indicator)', () => {
    expect(CREATE_ENRICHMENT_TABLE).toContain('PRIMARY KEY (provider, indicator)')
    expect(CACHE_PUT_SQL).toContain('ON CONFLICT(provider, indicator) DO UPDATE')
  })
})
