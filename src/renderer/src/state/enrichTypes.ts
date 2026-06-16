// Renderer-side enrichment types. Mirror the main/preload shapes by value (the main and renderer
// tsconfigs don't share modules — same convention as csvTypes.ts vs sql.ts).

export type IndicatorKind = 'ipv4' | 'ipv6' | 'domain' | 'url' | 'email' | 'md5' | 'sha1' | 'sha256'

/** One indicator queued for enrichment. */
export interface EnrichItem {
  value: string
  kind: IndicatorKind
}

export interface EnrichProviderInfo {
  id: string
  name: string
  kinds: string[]
  ready: boolean
  detail: string
}

export interface EnrichResultRow {
  indicator: string
  kind: string
  status: 'ok' | 'notfound' | 'error' | 'skipped' | 'private'
  fields: Record<string, string>
  fromCache: boolean
  fetchedAt?: number
  message?: string
}

export interface EnrichProgress {
  reqId: number
  done: number
  total: number
  current: string
  fromCache: boolean
}

export type EnrichBulkResult = { rows: EnrichResultRow[]; canceled?: boolean }

/** A cached result row across providers (cache READ only — no provider was run). */
export interface EnrichCachedRow {
  provider: string
  indicator: string
  kind: string
  status: 'ok' | 'notfound' | 'error'
  fields: Record<string, string>
  fetchedAt: number
}

// ---- Watchlists (analyst-curated context lists) ----
export type WatchlistKind = 'ip' | 'asn' | 'domain' | 'hash'

export interface WatchlistInfo {
  id: number
  name: string
  kind: WatchlistKind
  color: string | null
  updatedAt: number | null
  count: number
}
