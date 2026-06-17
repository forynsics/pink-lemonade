// The enrichment orchestrator. Given a provider and a list of indicators it: dedupes in-batch,
// skips kinds the provider can't handle, serves cache hits, looks up the misses, streams progress,
// and writes fresh results back to the cache. Provider-agnostic — VirusTotal will add concurrency
// + a rate limiter inside this same loop without changing its shape.
//
// Cancellation mirrors the chunked-distinct pattern: the caller supersedes by reqId and the loop
// checks shouldAbort() between indicators.

import * as cache from './cache'
import { PROVIDERS, getProvider } from './providers'
import { privateIpReason } from './ipranges'
import { RateLimitError } from './providers/errors'
import type { EnrichmentProvider, EnrichmentResult, IndicatorKind, LookupContext } from './providers/types'

export interface EnrichItem {
  value: string
  kind: IndicatorKind
}

export interface EnrichResultRow {
  indicator: string
  kind: string
  /** skipped = provider doesn't support this kind; private = non-routable/special-use IP, not enriched. */
  status: 'ok' | 'notfound' | 'error' | 'skipped' | 'private'
  fields: Record<string, string>
  fromCache: boolean
  /** When this result was fetched (epoch ms); set for ok/notfound rows, absent for skipped/private/error. */
  fetchedAt?: number
  message?: string
}

export interface ProviderInfo {
  id: string
  name: string
  kinds: string[]
  ready: boolean
  detail: string
}

export interface BulkProgress {
  done: number
  total: number
  current: string
  fromCache: boolean
}

/** In-memory run counters (not persisted) — handy for debugging throughput / quota burn. */
export interface BulkStats {
  cacheHits: number
  cacheMisses: number
  networkLookups: number
  rateLimitSleeps: number
  retryCount: number
  count429: number
  avgLatencyMs: number
}

export interface BulkResult {
  rows: EnrichResultRow[]
  canceled?: boolean
  /** Set when the run was stopped early for a non-cancel reason (e.g. daily VT quota exhausted). */
  aborted?: 'quota'
  message?: string
  stats?: BulkStats
}

/** Per-run secrets injected from main (the worker can't decrypt them itself). */
export interface BulkSecrets {
  apiKey?: string
  /** Effective pace for this run (auto-detected from the key's tier); 0/undefined = unthrottled. */
  requestsPerMinute?: number
}

/** Abort-aware sleep: resolves after `ms`, or early if `shouldAbort()` flips (checked in slices). */
async function abortableSleep(ms: number, shouldAbort: () => boolean): Promise<void> {
  const SLICE = 250
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (shouldAbort()) return
    await new Promise<void>((r) => setTimeout(r, Math.min(SLICE, end - Date.now())))
  }
}

export function listProviders(): ProviderInfo[] {
  return PROVIDERS.map((p) => {
    const s = p.status()
    return { id: p.id, name: p.name, kinds: p.kinds, ready: s.ready, detail: s.detail }
  })
}

export async function bulkLookup(
  dbPath: string,
  providerId: string,
  items: EnrichItem[],
  now: number,
  onProgress: (p: BulkProgress) => void,
  shouldAbort: () => boolean,
  secrets?: BulkSecrets,
  signal?: AbortSignal
): Promise<BulkResult> {
  const provider = getProvider(providerId)
  if (!provider) throw new Error(`unknown enrichment provider: ${providerId}`)
  const supported = new Set<string>(provider.kinds)
  const ctx: LookupContext = { apiKey: secrets?.apiKey, signal }
  // Effective client-side pace: per-run override (auto-detected from the key's tier) wins over the
  // provider default; 0/undefined means "don't throttle, just fire" (the API's 429 is the real cap).
  const rpm = secrets?.requestsPerMinute ?? provider.requestsPerMinute ?? 0

  // 1. Dedupe in-batch on the canonical (normalized) value, keeping first-seen order. Normalizing
  //    here (e.g. lowercasing hashes) means the cache key, lookup arg, and row indicator all agree.
  const seen = new Set<string>()
  const unique: EnrichItem[] = []
  for (const it of items) {
    if (!it || typeof it.value !== 'string' || it.value === '') continue
    const key = provider.normalizeValue?.(it.value, it.kind) ?? it.value
    if (seen.has(key)) continue
    seen.add(key)
    unique.push({ value: key, kind: it.kind })
  }

  // 2. Read the cache once for the supported indicators.
  const lookupable = unique.filter((it) => supported.has(it.kind)).map((it) => it.value)
  const cached = cache.get(dbPath, providerId, lookupable)

  const rows: EnrichResultRow[] = []
  const fresh: cache.PutEntry[] = []
  const total = unique.length
  let done = 0

  const stats: BulkStats = { cacheHits: 0, cacheMisses: 0, networkLookups: 0, rateLimitSleeps: 0, retryCount: 0, count429: 0, avgLatencyMs: 0 }
  let totalLatency = 0
  // Rolling window of recent real-request timestamps, used only when rpm > 0.
  const recent: number[] = []

  const flush = (extra?: Partial<BulkResult>): BulkResult => {
    if (fresh.length > 0) cache.put(dbPath, providerId, fresh, now)
    stats.avgLatencyMs = stats.networkLookups > 0 ? Math.round(totalLatency / stats.networkLookups) : 0
    return { rows, stats, ...extra }
  }

  for (const it of unique) {
    if (shouldAbort()) return flush({ canceled: true })

    if (!supported.has(it.kind)) {
      rows.push({
        indicator: it.value,
        kind: it.kind,
        status: 'skipped',
        fields: {},
        fromCache: false,
        message: `${provider.name} doesn't support ${it.kind}`
      })
      onProgress({ done: ++done, total, current: it.value, fromCache: false })
      continue
    }

    // Never enrich non-routable / special-use IPs — no meaningful data, and it would leak internal
    // addresses to network providers. Report the reason instead. (Not cached — it's deterministic.)
    // Local matchers that opt in (Watchlist) skip this: a Corporate list IS private ranges.
    if (!provider.matchesPrivateIps && (it.kind === 'ipv4' || it.kind === 'ipv6')) {
      const reason = privateIpReason(it.value)
      if (reason) {
        rows.push({ indicator: it.value, kind: it.kind, status: 'private', fields: {}, fromCache: false, message: reason })
        onProgress({ done: ++done, total, current: it.value, fromCache: false })
        continue
      }
    }

    const hit = cached.get(it.value)
    const isFresh = hit && (provider.ttlSeconds === Infinity || (now - hit.fetchedAt) / 1000 < provider.ttlSeconds)
    if (hit && isFresh) {
      stats.cacheHits++
      rows.push({ indicator: it.value, kind: it.kind, status: hit.status, fields: hit.fields, fromCache: true, fetchedAt: hit.fetchedAt })
      onProgress({ done: ++done, total, current: it.value, fromCache: true })
      continue
    }
    stats.cacheMisses++

    // Client-side pacing: if we've already issued `rpm` requests inside the trailing 60s window,
    // wait until the oldest ages out. Abort-aware so a cancel doesn't sit through the sleep.
    if (rpm > 0) {
      const trim = (): void => {
        const windowStart = Date.now() - 60_000
        while (recent.length && recent[0] < windowStart) recent.shift()
      }
      trim()
      if (recent.length >= rpm) {
        const waitMs = recent[0] + 60_000 - Date.now()
        if (waitMs > 0) {
          stats.rateLimitSleeps++
          await abortableSleep(waitMs, shouldAbort)
          if (shouldAbort()) return flush({ canceled: true })
        }
        trim()
      }
      recent.push(Date.now())
    }

    let result: EnrichmentResult
    const t0 = Date.now()
    try {
      result = await lookupWithRetry(provider, it.value, it.kind, ctx, shouldAbort, stats)
    } catch (e) {
      if (shouldAbort()) return flush({ canceled: true })
      if (e instanceof RateLimitError && (e.daily || e.fatal)) {
        // Stop the whole run rather than mark hundreds of remaining rows as errors.
        return flush({ canceled: true, aborted: 'quota', message: e.message || 'Daily quota exhausted' })
      }
      result = { status: 'error', fields: {}, message: e instanceof Error ? e.message : String(e) }
    }
    stats.networkLookups++
    totalLatency += Date.now() - t0

    rows.push({
      indicator: it.value,
      kind: it.kind,
      status: result.status,
      fields: result.fields,
      fromCache: false,
      fetchedAt: now,
      message: result.message
    })
    // Don't poison the cache with transient errors (bad config, network) — only persist real answers.
    // Skip volatile providers (ttl 0, e.g. Watchlist): their result can change between runs, so it's
    // recomputed each time and never cached.
    if (result.status !== 'error' && provider.ttlSeconds > 0) fresh.push({ indicator: it.value, kind: it.kind, result })

    onProgress({ done: ++done, total, current: it.value, fromCache: false })
    if (done % 200 === 0) await new Promise<void>((r) => setImmediate(r)) // yield on big batches
  }

  return flush()
}

/**
 * Run a single lookup, backing off + retrying once on a per-minute rate limit. A daily-quota error
 * is rethrown immediately (retrying can't help); a second rate-limit after the backoff is flagged
 * `fatal` so the caller aborts the run. Any non-rate-limit failure propagates to become an error row.
 */
async function lookupWithRetry(
  provider: EnrichmentProvider,
  value: string,
  kind: IndicatorKind,
  ctx: LookupContext,
  shouldAbort: () => boolean,
  stats: BulkStats
): Promise<EnrichmentResult> {
  try {
    return await provider.lookup(value, kind, ctx)
  } catch (e) {
    if (!(e instanceof RateLimitError)) throw e
    stats.count429++
    if (e.daily) throw e // fatal — caller aborts the run
    // Per-minute window: wait exactly Retry-After (or 60s) once, then try again.
    const waitMs = (e.retryAfter ?? 60) * 1000
    stats.retryCount++
    await abortableSleep(waitMs, shouldAbort)
    if (shouldAbort()) throw e
    try {
      return await provider.lookup(value, kind, ctx)
    } catch (e2) {
      if (e2 instanceof RateLimitError) {
        stats.count429++
        e2.fatal = true // persistent rate limit → fatal, don't error-spam every remaining row
        throw e2
      }
      throw e2
    }
  }
}
