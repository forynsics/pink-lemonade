// The enrichment cache. As of the "modular intel DB" model, the cache is no longer a single hidden
// file — it's any SQLite file the user opens/creates, each holding an `enrichment` table (results
// keyed by (provider, indicator)). This module keeps one connection per file path and every op is
// scoped to a path. Only the DB worker loads better-sqlite3, so this stays worker-only.

import Database from 'better-sqlite3'
import { join, dirname } from 'path'
import { mkdirSync } from 'fs'
import {
  CREATE_ENRICHMENT_TABLE,
  buildCacheGetSql,
  buildCacheGetAllSql,
  buildCacheDeleteSql,
  CACHE_PUT_SQL,
  CACHE_DUMP_SQL,
  CACHE_INDICATOR_COUNT_SQL
} from './sql'
import type { EnrichmentResult } from './providers/types'

let userDataDir = ''
const conns = new Map<string, Database.Database>()

export function initEnrichPaths(dir: string): void {
  userDataDir = dir
}

// The seamless default intel DB (the pre-modular single-cache file, so existing data isn't
// orphaned). It's labeled "default" in the UI; only the hover tooltip shows this real path.
export function defaultDbPath(): string {
  if (!userDataDir) throw new Error('enrich cache paths not initialized (initEnrichPaths must run first)')
  return join(userDataDir, 'enrichment.db')
}

// Open (creating if needed) the intel DB at `dbPath`; cache the connection. Creating a new DB is
// just opening a path that doesn't exist yet — the file + `enrichment` table are made on demand.
function conn(dbPath: string): Database.Database {
  let db = conns.get(dbPath)
  if (db) return db
  mkdirSync(dirname(dbPath), { recursive: true })
  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.exec(CREATE_ENRICHMENT_TABLE)
  conns.set(dbPath, db)
  return db
}

export interface CachedEntry {
  indicator: string
  kind: string
  status: 'ok' | 'notfound' | 'error'
  fields: Record<string, string>
  fetchedAt: number
}
export interface CachedAcrossProviders {
  provider: string
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

const GET_CHUNK = 900
/**
 * Max rows "Load all" pulls into the view. The Intel grid is virtualized (only on-screen rows are
 * in the DOM), so rendering is no longer the bottleneck — this ceiling now exists only to bound the
 * in-JS TanStack Table models (filter/sort/facet run over the full array). Renderer passes its own
 * limit; this is the fallback. Keep in sync with LOAD_CAP in EnrichmentView.tsx and the ipc default.
 */
export const DUMP_CAP = 50000

/** Cached entries for the given indicators of one provider in `dbPath` — a Map of hits only. */
export function get(dbPath: string, provider: string, indicators: string[]): Map<string, CachedEntry> {
  const out = new Map<string, CachedEntry>()
  if (indicators.length === 0) return out
  const c = conn(dbPath)
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

/** Cached rows for the given indicators across ALL providers in `dbPath` (cache READ only). */
export function getMany(dbPath: string, indicators: string[]): CachedAcrossProviders[] {
  if (indicators.length === 0) return []
  const c = conn(dbPath)
  const out: CachedAcrossProviders[] = []
  for (let i = 0; i < indicators.length; i += GET_CHUNK) {
    const slice = indicators.slice(i, i + GET_CHUNK)
    const rows = c.prepare(buildCacheGetAllSql(slice.length)).all(...slice) as Array<CacheRow & { provider: string }>
    for (const r of rows) out.push(toAcross(r))
  }
  return out
}

/** Every row in `dbPath` (all providers/indicators), capped — powers "Load all from DB". */
export function dump(dbPath: string, limit = DUMP_CAP): CachedAcrossProviders[] {
  const rows = conn(dbPath).prepare(CACHE_DUMP_SQL).all(limit) as Array<CacheRow & { provider: string }>
  return rows.map(toAcross)
}

/** Count of distinct indicators stored in `dbPath`. */
export function indicatorCount(dbPath: string): number {
  const r = conn(dbPath).prepare(CACHE_INDICATOR_COUNT_SQL).get() as { n: number }
  return r.n
}

export interface PutEntry {
  indicator: string
  kind: string
  result: EnrichmentResult
}

/** Upsert fresh results into `dbPath`. `now` is passed in (stays clock-free). */
export function put(dbPath: string, provider: string, entries: PutEntry[], now: number): void {
  if (entries.length === 0) return
  const c = conn(dbPath)
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

/** Delete all cached rows (every provider) for the given indicators in `dbPath`. */
export function deleteMany(dbPath: string, indicators: string[]): void {
  if (indicators.length === 0) return
  const c = conn(dbPath)
  const tx = c.transaction((all: string[]) => {
    for (let i = 0; i < all.length; i += GET_CHUNK) {
      const slice = all.slice(i, i + GET_CHUNK)
      c.prepare(buildCacheDeleteSql(slice.length)).run(...slice)
    }
  })
  tx(indicators)
}

/** Close one DB's connection, or all of them (on quit). */
export function close(dbPath?: string): void {
  if (dbPath) {
    conns.get(dbPath)?.close()
    conns.delete(dbPath)
  } else {
    for (const [, db] of conns) db.close()
    conns.clear()
  }
}

function toAcross(r: CacheRow & { provider: string }): CachedAcrossProviders {
  return {
    provider: r.provider,
    indicator: r.indicator,
    kind: r.kind,
    status: r.status as CachedAcrossProviders['status'],
    fields: parseFields(r.fieldsJson),
    fetchedAt: r.fetchedAt
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
