// Pure VirusTotal helpers + constants — no network, no db, no Electron imports. Shared by the
// worker-side provider (virustotal.ts) and the main-side key validator (enrich/ipc.ts), and the
// home of everything worth unit-testing. The v3 response shapes differ slightly per indicator
// (IP / domain / file), so every accessor here is defensive against absent keys.

import type { IndicatorKind } from './types'

export const VT_API_BASE = 'https://www.virustotal.com/api/v3'
export const VT_GUI_BASE = 'https://www.virustotal.com/gui'

/** Default malicious-detection count at/above which a result is "Malicious". Kept a constant for
 *  now (a future setting); the renderer reads the stored verdict so re-coloring needs no re-lookup. */
export const VT_MALICIOUS_THRESHOLD = 2

export type VtVerdict = 'Clean' | 'Suspicious' | 'Malicious'

export interface VtStats {
  malicious?: number
  suspicious?: number
  [bucket: string]: number | undefined
}

/** Lowercase file hashes so case variants share one cache entry / request; leave IPs & domains. */
export function normalizeIndicator(value: string, kind: IndicatorKind): string {
  return kind === 'md5' || kind === 'sha1' || kind === 'sha256' ? value.toLowerCase() : value
}

/** malicious >= threshold → Malicious; any malicious/suspicious → Suspicious; else Clean.
 *  (HTTP 404 → Unknown is a *status*, handled by the engine/UI, not produced here.) */
export function deriveVerdict(
  stats: { malicious?: number; suspicious?: number } | undefined,
  threshold = VT_MALICIOUS_THRESHOLD
): VtVerdict {
  const malicious = stats?.malicious ?? 0
  const suspicious = stats?.suspicious ?? 0
  if (malicious >= threshold) return 'Malicious'
  if (malicious > 0 || suspicious > 0) return 'Suspicious'
  return 'Clean'
}

/** Sum of every numeric bucket in last_analysis_stats. Files carry extra buckets (e.g.
 *  type-unsupported, confirmed-timeout) that IPs/domains lack — summing all keeps "N / total" honest. */
export function sumStats(stats: VtStats | undefined): number {
  if (!stats || typeof stats !== 'object') return 0
  let total = 0
  for (const v of Object.values(stats)) if (typeof v === 'number' && Number.isFinite(v)) total += v
  return total
}

/** GUI deep-link for "View on VirusTotal". id is the IP, domain, or (lowercased) hash. */
export function vtGuiLink(kind: IndicatorKind, value: string): string {
  const seg = kind === 'domain' ? 'domain' : kind === 'ipv4' || kind === 'ipv6' ? 'ip-address' : 'file'
  return `${VT_GUI_BASE}/${seg}/${encodeURIComponent(value)}`
}

function epochToDate(sec: unknown): string | null {
  if (typeof sec !== 'number' || !Number.isFinite(sec)) return null
  const d = new Date(sec * 1000)
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
}

/**
 * Turn a v3 `data.attributes` object into the flat label→value display fields. Stores raw counts +
 * the precomputed verdict; never dumps `last_analysis_results`. Adds a field only when present.
 */
export function curateFields(kind: IndicatorKind, value: string, attributes: Record<string, unknown>): Record<string, string> {
  const a = attributes ?? {}
  const stats = (a.last_analysis_stats as VtStats | undefined) ?? undefined
  const malicious = stats?.malicious ?? 0
  const suspicious = stats?.suspicious ?? 0

  const f: Record<string, string> = {
    'VT Verdict': deriveVerdict({ malicious, suspicious }),
    'VT Malicious': String(malicious),
    'VT Suspicious': String(suspicious),
    'VT Total': String(sumStats(stats)),
    'VT Link': vtGuiLink(kind, value)
  }
  if (typeof a.reputation === 'number') f.Reputation = String(a.reputation)

  if (kind === 'ipv4' || kind === 'ipv6') {
    if (typeof a.as_owner === 'string' && a.as_owner) f['AS Owner'] = a.as_owner
    if (typeof a.asn === 'number') f.ASN = `AS${a.asn}`
    if (typeof a.country === 'string' && a.country) f.Country = a.country
    if (typeof a.network === 'string' && a.network) f.Network = a.network
  } else if (kind === 'domain') {
    if (typeof a.registrar === 'string' && a.registrar) f.Registrar = a.registrar
    const cats = a.categories as Record<string, string> | undefined
    if (cats && typeof cats === 'object') {
      const vals = [...new Set(Object.values(cats).filter((v): v is string => typeof v === 'string' && v !== ''))]
      if (vals.length) f.Categories = vals.join(', ')
    }
    const created = epochToDate(a.creation_date)
    if (created) f.Created = created
  } else {
    // file (md5 / sha1 / sha256)
    if (typeof a.meaningful_name === 'string' && a.meaningful_name) f.Name = a.meaningful_name
    if (typeof a.type_description === 'string' && a.type_description) f.Type = a.type_description
    if (typeof a.size === 'number') f.Size = String(a.size)
  }
  return f
}

export interface VtTier {
  tier: 'free' | 'premium'
  dailyQuota: number | null
  requestsPerMinute: number
}

/**
 * Infer the key's tier from a v3 `/users/{id}` `data.attributes` object. Free tier = 500 req/day →
 * pace at 4/min; higher → unthrottled (let 429 govern). Unknown shape → safe free-tier default.
 */
export function deriveTier(attributes: Record<string, unknown> | undefined): VtTier {
  const quotas = attributes?.quotas as Record<string, { allowed?: number }> | undefined
  const daily = quotas?.api_requests_daily?.allowed
  if (typeof daily === 'number' && Number.isFinite(daily)) {
    return daily <= 500
      ? { tier: 'free', dailyQuota: daily, requestsPerMinute: 4 }
      : { tier: 'premium', dailyQuota: daily, requestsPerMinute: 0 }
  }
  return { tier: 'free', dailyQuota: null, requestsPerMinute: 4 }
}
