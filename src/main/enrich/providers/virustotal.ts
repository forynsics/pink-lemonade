// VirusTotal provider: online IP / domain / file-hash reputation via the v3 API. Runs in the DB
// worker like every provider, but unlike MaxMind it needs a secret: the user's API key. safeStorage
// decrypts only in main, so the worker can't read the key itself — the engine injects it per run via
// LookupContext.apiKey (see engine.ts / ipc.ts). The key travels in the x-apikey header, never the URL.
//
// Caching: ttlSeconds Infinity (a verdict never auto-expires — the analyst forces a re-check when
// they want fresh data, which keeps the free-tier 500/day quota under their control). 404 → notfound
// (Unknown), which the engine still caches, so re-runs don't re-spend quota on unknown indicators.

import { getEnrichConfig } from '../../csv/db'
import { RateLimitError } from './errors'
import { VT_API_BASE, curateFields, normalizeIndicator } from './vtShared'
import type { EnrichmentProvider, EnrichmentResult, IndicatorKind, LookupContext, ProviderStatus } from './types'


const REQUEST_TIMEOUT_MS = 15_000

/** v3 endpoint path for an indicator, or null if VT can't look up that kind. */
function endpointFor(kind: IndicatorKind, value: string): string | null {
  if (kind === 'ipv4' || kind === 'ipv6') return `ip_addresses/${encodeURIComponent(value)}`
  if (kind === 'domain') return `domains/${encodeURIComponent(value)}`
  if (kind === 'md5' || kind === 'sha1' || kind === 'sha256') return `files/${encodeURIComponent(value)}`
  return null
}

/** Per-request signal: the run's abort signal (cancel) combined with a 15s timeout. */
function requestSignal(ctx?: LookupContext): AbortSignal {
  const signals = [ctx?.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)].filter((s): s is AbortSignal => !!s)
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals)
}

export const virustotalProvider: EnrichmentProvider = {
  id: 'virustotal',
  name: 'VirusTotal',
  kinds: ['ipv4', 'ipv6', 'domain', 'md5', 'sha1', 'sha256'],
  ttlSeconds: Infinity, // a verdict never auto-expires; the analyst forces a re-check explicitly
  requestsPerMinute: 4, // free-tier default; the per-run override (auto-detected) supersedes this
  normalizeValue: normalizeIndicator,

  status(): ProviderStatus {
    const c = getEnrichConfig()
    const stored = typeof c.vtKeyEnc === 'string' && c.vtKeyEnc !== ''
    // "stored" not "valid": the worker can't decrypt/validate the key (no safeStorage). Validation
    // happens in main when the key is saved; a bad key surfaces as a per-row error at run time.
    return stored ? { ready: true, detail: 'API key stored' } : { ready: false, detail: 'No API key' }
  },

  async lookup(value: string, kind: IndicatorKind, ctx?: LookupContext): Promise<EnrichmentResult> {
    if (!ctx?.apiKey) return { status: 'error', fields: {}, message: 'VirusTotal API key not configured' }
    const endpoint = endpointFor(kind, value)
    if (!endpoint) return { status: 'error', fields: {}, message: `VirusTotal can't look up ${kind}` }

    let res: Response
    try {
      res = await fetch(`${VT_API_BASE}/${endpoint}`, {
        headers: { 'x-apikey': ctx.apiKey, accept: 'application/json' },
        signal: requestSignal(ctx)
      })
    } catch (e) {
      const msg = e instanceof Error && e.name === 'AbortError' ? 'VirusTotal request canceled or timed out' : e instanceof Error ? e.message : String(e)
      return { status: 'error', fields: {}, message: msg }
    }

    if (res.status === 404) return { status: 'notfound', fields: {}, message: 'No VirusTotal record' }
    if (res.status === 401) return { status: 'error', fields: {}, message: 'Invalid VirusTotal API key' }
    if (res.status === 429) {
      const ra = Number.parseInt(res.headers.get('retry-after') ?? '', 10)
      let daily = false
      try {
        const body = (await res.json()) as { error?: { code?: string } }
        daily = body?.error?.code === 'QuotaExceededError'
      } catch {
        /* body may be empty/non-JSON */
      }
      throw new RateLimitError('VirusTotal rate limit', { retryAfter: Number.isFinite(ra) ? ra : undefined, daily })
    }
    if (!res.ok) return { status: 'error', fields: {}, message: `VirusTotal HTTP ${res.status}` }

    let body: { data?: { attributes?: Record<string, unknown> } }
    try {
      body = (await res.json()) as typeof body
    } catch {
      return { status: 'error', fields: {}, message: 'Unreadable VirusTotal response' }
    }
    return { status: 'ok', fields: curateFields(kind, value, body?.data?.attributes ?? {}) }
  }
}
