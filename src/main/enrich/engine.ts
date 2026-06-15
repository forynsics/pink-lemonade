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
import type { EnrichmentResult, IndicatorKind } from './providers/types'

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

export interface BulkResult {
  rows: EnrichResultRow[]
  canceled?: boolean
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
  shouldAbort: () => boolean
): Promise<BulkResult> {
  const provider = getProvider(providerId)
  if (!provider) throw new Error(`unknown enrichment provider: ${providerId}`)
  const supported = new Set<string>(provider.kinds)

  // 1. Dedupe in-batch, keeping first-seen order (the same IP appears across many rows).
  const seen = new Set<string>()
  const unique: EnrichItem[] = []
  for (const it of items) {
    if (!it || typeof it.value !== 'string' || it.value === '') continue
    if (seen.has(it.value)) continue
    seen.add(it.value)
    unique.push(it)
  }

  // 2. Read the cache once for the supported indicators.
  const lookupable = unique.filter((it) => supported.has(it.kind)).map((it) => it.value)
  const cached = cache.get(dbPath, providerId, lookupable)

  const rows: EnrichResultRow[] = []
  const fresh: cache.PutEntry[] = []
  const total = unique.length
  let done = 0

  for (const it of unique) {
    if (shouldAbort()) return { rows, canceled: true }

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
    if (it.kind === 'ipv4' || it.kind === 'ipv6') {
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
      rows.push({ indicator: it.value, kind: it.kind, status: hit.status, fields: hit.fields, fromCache: true, fetchedAt: hit.fetchedAt })
      onProgress({ done: ++done, total, current: it.value, fromCache: true })
      continue
    }

    let result: EnrichmentResult
    try {
      result = await provider.lookup(it.value, it.kind)
    } catch (e) {
      result = { status: 'error', fields: {}, message: e instanceof Error ? e.message : String(e) }
    }
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
    if (result.status !== 'error') fresh.push({ indicator: it.value, kind: it.kind, result })

    onProgress({ done: ++done, total, current: it.value, fromCache: false })
    if (done % 200 === 0) await new Promise<void>((r) => setImmediate(r)) // yield on big batches
  }

  if (fresh.length > 0) cache.put(dbPath, providerId, fresh, now)
  return { rows }
}
