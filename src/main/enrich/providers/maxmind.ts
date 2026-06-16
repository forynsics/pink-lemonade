// MaxMind GeoIP provider: looks up an IP against local .mmdb databases (GeoLite2-City for geo +
// GeoLite2-ASN for the network owner). Pure-JS reader — no network at lookup time, no rate limit.
// The .mmdb files are installed by the setup helper (maxmindSetup.ts) using the user's free license
// key; their paths live in settings.json under `enrich` (maxmindCityPath / maxmindAsnPath).

import { open, validate, type Reader, type Response } from 'maxmind'
import { existsSync, statSync } from 'fs'
import { basename } from 'path'
import { getEnrichConfig } from '../../csv/db'
import type { EnrichmentProvider, EnrichmentResult, IndicatorKind, ProviderStatus } from './types'

/** Configured + present .mmdb paths (City first, then ASN). */
function dbPaths(): string[] {
  const c = getEnrichConfig()
  return [c.maxmindCityPath, c.maxmindAsnPath].filter(
    (p): p is string => typeof p === 'string' && p !== '' && existsSync(p)
  )
}

// Readers cached by `path:mtimeMs`, so a re-downloaded (updated) DB at the same path reloads
// automatically — no explicit cache invalidation needed.
const readers = new Map<string, Reader<Response>>()
async function readerFor(path: string): Promise<Reader<Response> | null> {
  let key: string
  try {
    key = `${path}:${statSync(path).mtimeMs}`
  } catch {
    return null
  }
  const cached = readers.get(key)
  if (cached) return cached
  try {
    const r = await open<Response>(path)
    readers.set(key, r)
    return r
  } catch {
    return null
  }
}

async function activeReaders(): Promise<Reader<Response>[]> {
  const out: Reader<Response>[] = []
  for (const p of dbPaths()) {
    const r = await readerFor(p)
    if (r) out.push(r)
  }
  return out
}

/**
 * Resolve an IP's ASN from the installed GeoLite2-ASN database, or null if not configured / no
 * record. Reused by the Watchlist provider so ASN watchlists can match without duplicating the
 * reader/caching logic. Returns just the number (e.g. 15169), not "AS15169".
 */
export async function asnForIp(value: string): Promise<number | null> {
  if (!validate(value)) return null
  for (const r of await activeReaders()) {
    const rec = r.get(value) as Record<string, unknown> | null
    if (rec && typeof rec.autonomous_system_number === 'number') return rec.autonomous_system_number
  }
  return null
}

/** Pull the human-interesting fields out of whatever record type we got (City/Country/ASN/ISP). */
function extractFields(rec: Response): Record<string, string> {
  const r = rec as Record<string, unknown>
  const f: Record<string, string> = {}

  const country = r.country as { iso_code?: string; names?: { en?: string } } | undefined
  if (country?.iso_code) {
    f.Country = country.names?.en ? `${country.names.en} (${country.iso_code})` : country.iso_code
  }
  const sub = (r.subdivisions as Array<{ names?: { en?: string } }> | undefined)?.[0]
  if (sub?.names?.en) f.Region = sub.names.en
  const city = r.city as { names?: { en?: string } } | undefined
  if (city?.names?.en) f.City = city.names.en
  const loc = r.location as { latitude?: number; longitude?: number } | undefined
  if (loc?.latitude != null && loc?.longitude != null) f['Lat/Lon'] = `${loc.latitude}, ${loc.longitude}`
  if (!f.Country) {
    const continent = r.continent as { names?: { en?: string } } | undefined
    if (continent?.names?.en) f.Continent = continent.names.en
  }

  if (r.autonomous_system_number != null) f.ASN = `AS${String(r.autonomous_system_number)}`
  const org = r.autonomous_system_organization ?? r.isp ?? r.organization
  if (typeof org === 'string' && org) f.Org = org

  return f
}

export const maxmindProvider: EnrichmentProvider = {
  id: 'maxmind',
  name: 'MaxMind GeoIP',
  kinds: ['ipv4', 'ipv6'],
  ttlSeconds: Infinity, // local file — a result never goes stale on its own

  status(): ProviderStatus {
    const ps = dbPaths()
    if (ps.length === 0) return { ready: false, detail: 'No database configured' }
    return { ready: true, detail: ps.map((p) => basename(p).replace(/\.mmdb$/i, '')).join(' + ') }
  },

  async lookup(value: string, kind: IndicatorKind): Promise<EnrichmentResult> {
    if (kind !== 'ipv4' && kind !== 'ipv6') {
      return { status: 'error', fields: {}, message: 'MaxMind looks up IP addresses only' }
    }
    if (!validate(value)) return { status: 'error', fields: {}, message: 'Not a valid IP address' }
    const rs = await activeReaders()
    if (rs.length === 0) return { status: 'error', fields: {}, message: 'MaxMind database not configured' }

    // Merge fields across all DBs (City contributes geo, ASN contributes owner/org).
    const fields: Record<string, string> = {}
    let hit = false
    for (const r of rs) {
      const rec = r.get(value)
      if (rec) {
        hit = true
        Object.assign(fields, extractFields(rec))
      }
    }
    if (!hit) return { status: 'notfound', fields: {}, message: 'No record (private/reserved or absent)' }
    return { status: 'ok', fields }
  }
}
