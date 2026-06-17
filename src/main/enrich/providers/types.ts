// The provider seam reserved in the architecture: an enrichment provider turns one indicator
// (an IP, domain, hash, …) into a normalized result. Providers are looked up by id and run in
// the DB worker thread. MaxMind (local .mmdb) is the first; VirusTotal (network) layers on later
// without touching the engine/cache, which are provider-agnostic.

// Indicator categories the app recognizes. Mirrors what the renderer's classifyIndicator() can
// produce from tools/ioc/patterns.ts (kept in sync by value — there's no shared module across
// the main/renderer tsconfig split).
export type IndicatorKind = 'ipv4' | 'ipv6' | 'domain' | 'url' | 'email' | 'md5' | 'sha1' | 'sha256'

export interface EnrichmentResult {
  /** ok = found; notfound = provider has no data for it; error = the lookup itself failed. */
  status: 'ok' | 'notfound' | 'error'
  /** Flat label→value pairs for display (e.g. { Country: 'United States (US)', ASN: 'AS15169' }). */
  fields: Record<string, string>
  /** Optional human note (error reason / "not in database"). */
  message?: string
}

export interface ProviderStatus {
  ready: boolean
  /** Short human status for the UI ("GeoLite2-City.mmdb" / "No database configured"). */
  detail: string
}

/** Per-run context handed to lookup(). Carries secrets the worker can't derive itself (the API key
 *  is decrypted in main, since safeStorage is main-only, and injected per run) plus an abort signal
 *  so an in-flight request is canceled when the run is superseded/canceled. */
export interface LookupContext {
  apiKey?: string
  signal?: AbortSignal
}

export interface EnrichmentProvider {
  id: string
  name: string
  /** Indicator kinds this provider can look up; anything else is reported as skipped. */
  kinds: IndicatorKind[]
  /** Seconds a cached result stays fresh. Infinity = never expires (local data like MaxMind). */
  ttlSeconds: number
  /** When true, the engine still runs this provider for non-routable/special-use IPs instead of
   *  short-circuiting them as "private". Set for local matchers like Watchlist where matching a
   *  private range (e.g. a Corporate 10.0.0.0/8) is the whole point. Network providers leave it off
   *  (sending an internal IP out would leak it). */
  matchesPrivateIps?: boolean
  /** Default client-side pacing for network providers (requests/min). The engine treats a per-run
   *  override or 0/undefined as "unthrottled" and just fires, relying on the provider's own
   *  rate-limit (429) handling. Local providers omit it. */
  requestsPerMinute?: number
  /** Canonical form of an indicator for dedupe / cache key / lookup (e.g. VirusTotal lowercases
   *  hashes so case variants share one cache entry). Omitted = value used as-is. */
  normalizeValue?(value: string, kind: IndicatorKind): string
  /** Whether the provider is configured and ready to run (and why not, if not). Synchronous. */
  status(): ProviderStatus
  lookup(value: string, kind: IndicatorKind, ctx?: LookupContext): Promise<EnrichmentResult>
}
