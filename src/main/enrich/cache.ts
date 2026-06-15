// The app-wide enrichment cache: a single persistent SQLite DB at <userData>/enrichment.db,
// owned by the DB worker (the only thread that loads better-sqlite3). Value-keyed by
// (provider, indicator) so a lookup done anywhere — any workspace, any session — is reused for
// free everywhere. This is what makes "never repeat a lookup" true and saves API quota.

import Database from 'better-sqlite3'
import { join } from 'path'
import {
  CREATE_ENRICHMENT_TABLE,
  buildCacheGetSql,
  buildCacheGetAllSql,
  buildCacheDeleteSql,
  CACHE_PUT_SQL,
  CACHE_STATS_SQL,
  CACHE_CLEAR_ALL_SQL,
  CACHE_CLEAR_PROVIDER_SQL
} from './sql'
import type { EnrichmentResult } from './providers/types'

let userDataDir = ''
let db: Database.Database | null = null

export function initEnrichPaths(dir: string): void {
  userDataDir = dir
}

function conn(): Database.Database {
  if (db) return db
  if (!userDataDir) throw new Error('enrich cache paths not initialized (initEnrichPaths must run first)')
  const d = new Database(join(userDataDir, 'enrichment.db'))
  d.pragma('journal_mode = WAL')
  d.pragma('synchronous = NORMAL')
  d.exec(CREATE_ENRICHMENT_TABLE)
  db = d
  return d
}

export interface CachedEntry {
  indicator: string
  kind: string
  status: 'ok' | 'notfound' | 'error'
  fields: Record<string, string>
  fetchedAt: number
}

interface CacheRow {
  indicator: string
  kind: string
  status: string
  fieldsJson: string
  fetchedAt: number
}

// SQLite caps host parameters per statement (~32k); chunk well under it.
const GET_CHUNK = 900

/** Cached entries for the given indicators of one provider — a Map of hits only (misses absent). */
export function get(provider: string, indicators: string[]): Map<string, CachedEntry> {
  const out = new Map<string, CachedEntry>()
  if (indicators.length === 0) return out
  const c = conn()
  for (let i = 0; i < indicators.length; i += GET_CHUNK) {
    const slice = indicators.slice(i, i + GET_CHUNK)
    const rows = c.prepare(buildCacheGetSql(slice.length)).all(provider, ...slice) as CacheRow[]
    for (const r of rows) {
      out.set(r.indicator, {
        indicator: r.indicator,
        kind: r.kind,
        status: r.status as CachedEntry['status'],
        fields: parseFields(r.fieldsJson),
        fetchedAt: r.fetchedAt
      })
    }
  }
  return out
}

export interface CachedAcrossProviders {
  provider: string
  indicator: string
  kind: string
  status: 'ok' | 'notfound' | 'error'
  fields: Record<string, string>
  fetchedAt: number
}

/** Cached rows for the given indicators across ALL providers (cache READ only — never runs a
 *  provider). Powers "load what's already known when an indicator is added to the list." */
export function getMany(indicators: string[]): CachedAcrossProviders[] {
  if (indicators.length === 0) return []
  const c = conn()
  const out: CachedAcrossProviders[] = []
  for (let i = 0; i < indicators.length; i += GET_CHUNK) {
    const slice = indicators.slice(i, i + GET_CHUNK)
    const rows = c.prepare(buildCacheGetAllSql(slice.length)).all(...slice) as Array<CacheRow & { provider: string }>
    for (const r of rows) {
      out.push({
        provider: r.provider,
        indicator: r.indicator,
        kind: r.kind,
        status: r.status as CachedAcrossProviders['status'],
        fields: parseFields(r.fieldsJson),
        fetchedAt: r.fetchedAt
      })
    }
  }
  return out
}

export interface PutEntry {
  indicator: string
  kind: string
  result: EnrichmentResult
}

/** Upsert fresh results. `now` is passed in (the module stays clock-free, like csv/db.ts). */
export function put(provider: string, entries: PutEntry[], now: number): void {
  if (entries.length === 0) return
  const c = conn()
  const stmt = c.prepare(CACHE_PUT_SQL)
  const tx = c.transaction((items: PutEntry[]) => {
    for (const it of items) {
      stmt.run({
        provider,
        kind: it.kind,
        indicator: it.indicator,
        status: it.result.status,
        fieldsJson: JSON.stringify(it.result.fields ?? {}),
        fetchedAt: now
      })
    }
  })
  tx(entries)
}

export function stats(): Array<{ provider: string; n: number }> {
  return conn().prepare(CACHE_STATS_SQL).all() as Array<{ provider: string; n: number }>
}

/** Delete all cached rows (every provider) for the given indicators — "clear this entry". */
export function deleteMany(indicators: string[]): void {
  if (indicators.length === 0) return
  const c = conn()
  const tx = c.transaction((all: string[]) => {
    for (let i = 0; i < all.length; i += GET_CHUNK) {
      const slice = all.slice(i, i + GET_CHUNK)
      c.prepare(buildCacheDeleteSql(slice.length)).run(...slice)
    }
  })
  tx(indicators)
}

/** Clear the whole cache, or just one provider's rows. */
export function clear(provider?: string | null): void {
  const c = conn()
  if (provider) c.prepare(CACHE_CLEAR_PROVIDER_SQL).run(provider)
  else c.prepare(CACHE_CLEAR_ALL_SQL).run()
}

export function close(): void {
  if (db) {
    db.close()
    db = null
  }
}

function parseFields(json: string): Record<string, string> {
  try {
    const o = JSON.parse(json) as unknown
    return o && typeof o === 'object' ? (o as Record<string, string>) : {}
  } catch {
    return {}
  }
}
