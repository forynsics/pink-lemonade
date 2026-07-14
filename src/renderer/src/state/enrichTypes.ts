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
  /** The row that just finished — present so the grid can render results live as they land. */
  row?: EnrichResultRow
}

/** A cached result row across providers (cache READ only — no provider was run). */
export interface EnrichCachedRow {
  provider: string
  indicator: string
  kind: string
  status: 'ok' | 'notfound' | 'error'
  fields: Record<string, string>
  fetchedAt: number
}

// ---- AI assistant (mirrors preload AiApi shapes by value) ----
export interface AiProviderInfo {
  id: string
  name: string
  ready: boolean
  detail: string
}
export interface AiConfig {
  provider: string
  model: string
  providers: AiProviderInfo[]
}
export interface AiWsColumn {
  name: string
  original: string
  time?: string
}
/** One source (imported artifact/CSV) in the active workspace. */
export interface AiWsSource {
  sourceId: number
  tabId: string
  name: string
  columns: AiWsColumn[]
  rowCount: number
  /** Analyst-assigned grouping label (host/system/origin); null = ungrouped. */
  group?: string | null
  /** True for a derived source (the materialized Timeline) — excluded from the agent's triage coverage. */
  derived?: boolean
}
/** The active-workspace context the renderer sends with each chat turn — all sources. */
export interface AiWsCtx {
  hasWorkspace: boolean
  wsId?: string
  workspaceName?: string
  activeSourceId?: number | null
  sources: AiWsSource[]
  intelDbPath?: string
}
export interface AiChatMessage {
  role: 'user' | 'assistant'
  content: string
}
export type AiEventPayload =
  | { reqId: number; type: 'token'; delta: string }
  | {
      reqId: number
      type: 'tool'
      phase: 'start' | 'done' | 'error'
      id: string
      name: string
      args?: unknown
      card?: string
      result?: unknown
      message?: string
    }
  | { reqId: number; type: 'action'; actionId: string; kind: string; summary: string; detail?: string; tag?: string; count?: number; sourceId?: number; group?: string | null }
  | { reqId: number; type: 'done'; truncated?: boolean }
  | { reqId: number; type: 'error'; message?: string }

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
