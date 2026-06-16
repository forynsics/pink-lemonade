// The Watchlist "provider": instead of fetching facts, it reports which of the analyst's curated
// lists an indicator belongs to (Corporate, Bad ASN, …). It slots into the provider-agnostic engine
// like MaxMind/VirusTotal, so it appears in the provider selector and its `Lists` field becomes a
// results column with no grid changes. Membership is volatile (lists are user-editable), so
// ttlSeconds = 0 — the engine recomputes every run and never caches it (see engine.ts).

import * as store from '../watchlistStore'
import { asnForIp } from './maxmind'
import type { EnrichmentProvider, EnrichmentResult, IndicatorKind, ProviderStatus } from './types'

export const watchlistProvider: EnrichmentProvider = {
  id: 'watchlist',
  name: 'Watchlist',
  kinds: ['ipv4', 'ipv6', 'domain', 'md5', 'sha1', 'sha256'],
  ttlSeconds: 0, // volatile — never cache a membership; a list edit takes effect on the next run
  matchesPrivateIps: true, // Corporate lists ARE private ranges — must match them, not skip them

  status(): ProviderStatus {
    let lists: ReturnType<typeof store.listLists>
    try {
      lists = store.listLists()
    } catch {
      return { ready: true, detail: 'No lists yet' }
    }
    if (lists.length === 0) return { ready: true, detail: 'No lists yet — add some in Watchlists' }
    const entries = lists.reduce((n, l) => n + l.count, 0)
    return { ready: true, detail: `${lists.length} list${lists.length === 1 ? '' : 's'} · ${entries} entries` }
  },

  async lookup(value: string, kind: IndicatorKind): Promise<EnrichmentResult> {
    // Only resolve the ASN (a MaxMind read) when there's an ASN list to match it against.
    let asn: number | null = null
    if ((kind === 'ipv4' || kind === 'ipv6') && store.hasAsnLists()) asn = await asnForIp(value)

    // Always "ok": a membership check always succeeds. No match just means a blank Lists cell —
    // not "notfound", which reads like an error for the common (and expected) non-member case.
    const hits = store.matchIndicator(value, kind, asn)
    return { status: 'ok', fields: { Lists: hits.join(', ') } }
  }
}
