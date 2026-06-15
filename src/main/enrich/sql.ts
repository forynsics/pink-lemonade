// Pure SQL for the app-wide enrichment cache — no better-sqlite3 import, fully unit-testable.
// The cache is value-keyed: one row per (provider, indicator), so the same IP is looked up once
// and reused across every workspace, source, and session.

export const CREATE_ENRICHMENT_TABLE = `CREATE TABLE IF NOT EXISTS enrichment (
  provider    TEXT NOT NULL,
  kind        TEXT NOT NULL,
  indicator   TEXT NOT NULL,
  status      TEXT NOT NULL,
  fields_json TEXT NOT NULL,
  fetched_at  INTEGER NOT NULL,
  PRIMARY KEY (provider, indicator)
)`

/** SELECT cached rows for `count` indicators of one provider. Bind: provider, then each indicator. */
export function buildCacheGetSql(count: number): string {
  if (count < 1) throw new Error('buildCacheGetSql: count must be >= 1')
  const placeholders = Array.from({ length: count }, () => '?').join(', ')
  return `SELECT indicator, kind, status, fields_json AS fieldsJson, fetched_at AS fetchedAt
          FROM enrichment WHERE provider = ? AND indicator IN (${placeholders})`
}

/** SELECT cached rows for `count` indicators across ALL providers (for the "load what's known on
 *  Add" read). Bind: each indicator. */
export function buildCacheGetAllSql(count: number): string {
  if (count < 1) throw new Error('buildCacheGetAllSql: count must be >= 1')
  const placeholders = Array.from({ length: count }, () => '?').join(', ')
  return `SELECT provider, indicator, kind, status, fields_json AS fieldsJson, fetched_at AS fetchedAt
          FROM enrichment WHERE indicator IN (${placeholders})`
}

/** Upsert one cached result. Bind by name (@provider, @kind, …). */
export const CACHE_PUT_SQL = `INSERT INTO enrichment (provider, kind, indicator, status, fields_json, fetched_at)
  VALUES (@provider, @kind, @indicator, @status, @fieldsJson, @fetchedAt)
  ON CONFLICT(provider, indicator) DO UPDATE SET
    kind = excluded.kind,
    status = excluded.status,
    fields_json = excluded.fields_json,
    fetched_at = excluded.fetched_at`

export const CACHE_STATS_SQL = `SELECT provider, COUNT(*) AS n FROM enrichment GROUP BY provider`
/** Every row in the DB (all providers, all indicators), ordered + capped — powers "Load all". Bind: limit. */
export const CACHE_DUMP_SQL = `SELECT provider, indicator, kind, status, fields_json AS fieldsJson, fetched_at AS fetchedAt
  FROM enrichment ORDER BY indicator LIMIT ?`
/** Count of distinct indicators stored (for the DB's entry-count label). */
export const CACHE_INDICATOR_COUNT_SQL = `SELECT COUNT(DISTINCT indicator) AS n FROM enrichment`
export const CACHE_CLEAR_ALL_SQL = `DELETE FROM enrichment`
export const CACHE_CLEAR_PROVIDER_SQL = `DELETE FROM enrichment WHERE provider = ?`

/** DELETE all cached rows (every provider) for `count` indicators. Bind: each indicator. */
export function buildCacheDeleteSql(count: number): string {
  if (count < 1) throw new Error('buildCacheDeleteSql: count must be >= 1')
  const placeholders = Array.from({ length: count }, () => '?').join(', ')
  return `DELETE FROM enrichment WHERE indicator IN (${placeholders})`
}
