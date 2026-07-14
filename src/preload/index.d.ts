export type TimeKind = 'iso' | 'epoch_s' | 'epoch_ms'
export interface CsvColumn {
  name: string
  original: string
  time?: TimeKind
}
export interface CsvOpenResult {
  tabId: string
  sourceName: string
  columns: CsvColumn[]
  rowCount: number
  dbPath: string
}
/** A source (an imported CSV) inside a workspace. */
export interface SourceInfo {
  sourceId: number
  name: string
  columns: CsvColumn[]
  rowCount: number
  /** Absolute path the file was imported from — used to detect re-imports of the same file. */
  originalPath: string
  /** Analyst-assigned grouping label (host/system/origin the evidence belongs to); null = ungrouped. */
  group: string | null
}
/** An open workspace and its sources (capstone). */
export interface WorkspaceInfo {
  wsId: string
  dbPath: string
  name: string
  sources: SourceInfo[]
  intelMode: 'global' | 'workspace'
}
export interface CsvSort {
  col: string
  dir: 'asc' | 'desc'
  numeric?: boolean
}
export type CsvFilter =
  | { col: string; op: 'eq' | 'like' | 'neq' | 'nlike'; value: string }
  | { col: string; op: 'in'; values: string[] }
  | { col: string; op: 'timearound'; value: string; tkind: TimeKind; deltaSec: number }
  | { col: string; op: 'timerange'; tkind: TimeKind; from?: number; to?: number }
  | { op: 'tag'; tags: string[]; exclude?: boolean }
  | { op: 'sighting'; indicators?: string[]; exclude?: boolean }
  | { op: 'aimark'; exclude?: boolean }
  | { op: 'rids'; rids: number[] }
export interface CsvQueryOpts {
  sort?: CsvSort
  filters?: CsvFilter[]
  search?: string
  limit: number
  offset: number
}
export interface CsvRowsResult {
  rows: string[][]
  /** Positional rowid of each row (aligned with `rows`) — row identity for tags + scroll-to-row. */
  rids: number[]
}
/** A row's AI-accountability mark: rid = positional rowid, note = what the assistant asserted. */
export interface CsvAiMark {
  rid: number
  note: string | null
}
/** Where a finding was validated to appear: one per source it was found in. */
export interface CsvFindingHit {
  sourceId: number
  sourceName: string
  count: number
  rids: number[]
}
/** A finding (constellation node): a validated indicator/artifact + its per-source presence. */
export interface CsvFinding {
  id: string
  value: string
  kind: string | null
  label: string | null
  note: string | null
  createdAt: number
  hits: CsvFindingHit[]
}
/** One time column's epoch-second span over an evidence item (kind = the source's column header). */
export interface CsvEvidenceSpan {
  kind: string
  colRef: string | null
  tsMin: number
  tsMax: number
}
/** One piece of evidence for an event: the rows in a source that corroborate it. */
export interface CsvEventEvidence {
  /** event_evidence row id — lets the UI target a single piece for re-grouping/removal. */
  id?: number
  sourceId: number
  sourceName: string
  matched: string
  count: number
  rids: number[]
  /** Per-time-column spans (Created vs Modified kept distinct) — the Timeline emits one row per kind. */
  spans: CsvEvidenceSpan[]
  /** Epoch-second envelope across the spans; null when undated. */
  tsMin: number | null
  tsMax: number | null
}
/** An event (Artifact Constellation node): an action that transpired + its corroborating evidence. */
export interface CsvEvent {
  id: string
  label: string
  description: string | null
  technique: string | null
  createdAt: number
  /** Who authored this event's interpretation — 'analyst' events are badged + protected from AI overwrite. */
  actor: 'ai' | 'analyst'
  /** User account(s) the event involves (curated attribution) — fills the Timeline's User column. */
  users: string[]
  evidence: CsvEventEvidence[]
}
/** A catalogued IOC (its own store; not auto-sent to the Intel grid). */
export interface CsvIoc {
  id: string
  value: string
  type: string
  context: string | null
  createdAt: number
}
/** One step of the AI investigation plan (an analyst-editable to-do/lead). */
export interface CsvPlanStep {
  text: string
  status: 'pending' | 'active' | 'done'
}
/** The persistent investigation state: plan + progress notes, shared by the agent and the analyst. */
export interface CsvInvestigation {
  plan: CsvPlanStep[]
  notes: string
  updatedAt: number | null
}
/** A saved AI conversation's metadata (no turns) — drives the history list. */
export interface CsvConversationMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  turnCount: number
}
/** A full saved AI conversation, with its opaque renderer-side turns. */
export interface CsvConversation extends CsvConversationMeta {
  turns: unknown[]
}
/** A row's tag in a source: rid = positional rowid, tag = one of the tag category ids. */
export interface CsvRowTag {
  rid: number
  tag: string
  /** Provenance: null for the analyst's own tags, 'ai' for assistant-applied ones. */
  actor?: string | null
}
/** Live progress of a chunked match count (Scale #2). */
export interface CsvCountProgress {
  tabId: string
  reqId: number
  count: number
  scanned: number
  max: number
}
export type CsvCountResult = { count: number } | { canceled: true }
export interface CsvDistinctRow {
  val: string
  cnt: number
}
/** Live progress of a chunked distinct scan. */
export interface CsvDistinctProgress {
  tabId: string
  reqId: number
  scanned: number
  count: number
  max: number
}
/** Live progress of a chunked intel sweep (rows scanned + sightings found so far). */
export interface CsvSweepProgress {
  tabId: string
  reqId: number
  sightings: number
  scanned: number
  max: number
}
export interface CsvColumnStats {
  count: number
  nullCount: number
  distinct: number
}
export interface CsvProgress {
  tabId: string
  bytes: number
  rows: number
  total: number
  phase: 'parsing' | 'indexing' | 'done'
}

export interface CsvApi {
  pick: () => Promise<{ path: string; sourceName: string } | null>
  pickMany: () => Promise<Array<{ path: string; sourceName: string }> | null>
  pickFolder: () => Promise<{ name: string; files: Array<{ path: string; sourceName: string; relPath: string; size: number }> } | null>
  pickDb: () => Promise<string | null>
  ingest: (tabId: string, path: string) => Promise<CsvOpenResult | null>
  open: (tabId: string, dbPath: string) => Promise<CsvOpenResult>
  deleteDb: (dbPath: string) => Promise<null>
  wsCreate: (wsId: string, name: string) => Promise<WorkspaceInfo>
  wsOpen: (wsId: string, dbPath: string) => Promise<WorkspaceInfo>
  wsClose: (wsId: string) => Promise<null>
  wsDelete: (dbPath: string) => Promise<null>
  wsAddSource: (wsId: string, path: string) => Promise<SourceInfo | null>
  /** Ingest an Excel workbook (.xlsx/.xlsm) → one source per non-empty worksheet. */
  wsAddXlsx: (wsId: string, path: string) => Promise<SourceInfo[] | null>
  wsRename: (wsId: string, name: string) => Promise<null>
  wsSetIntelMode: (wsId: string, mode: 'global' | 'workspace') => Promise<null>
  wsRemoveSource: (wsId: string, sourceId: number) => Promise<null>
  wsRenameSource: (wsId: string, sourceId: number, name: string) => Promise<null>
  wsSetSourceGroup: (wsId: string, sourceId: number, group: string | null) => Promise<null>
  /** Extract scalar JSON sub-fields of `jsonCol` into new grid columns on the source; returns them. */
  wsAddDerivedColumns: (
    wsId: string,
    sourceId: number,
    jsonCol: string,
    fields: Array<{ path: string; displayName: string }>
  ) => Promise<CsvColumn[]>
  wsBuildTimeline: (wsId: string, header: string[], rows: string[][]) => Promise<SourceInfo | null>
  wsGetDir: () => Promise<string>
  wsSetDir: (dir: string) => Promise<string>
  wsPickDir: () => Promise<string | null>
  wsTagList: (wsId: string, sourceId: number) => Promise<CsvRowTag[]>
  wsAiMarkList: (wsId: string, sourceId: number) => Promise<CsvAiMark[]>
  wsAiMarkClear: (wsId: string, sourceId: number) => Promise<null>
  wsFindingList: (wsId: string) => Promise<CsvFinding[]>
  wsFindingDelete: (wsId: string, id: string) => Promise<null>
  wsFindingClear: (wsId: string) => Promise<null>
  wsEventList: (wsId: string) => Promise<CsvEvent[]>
  wsEventDelete: (wsId: string, id: string) => Promise<null>
  wsEventClear: (wsId: string) => Promise<null>
  wsEventUpdate: (wsId: string, id: string, fields: { label: string; description: string | null; technique: string | null; users: string[] }) => Promise<null>
  wsEvidenceDelete: (wsId: string, evidenceId: number) => Promise<null>
  wsEventCreateFromRows: (payload: {
    wsId: string
    sourceId: number
    sourceName: string
    rids: number[]
    rows: string[][]
    columns: Array<{ name: string; original: string; time: string | null }>
    label: string
    description: string | null
    technique: string | null
    users: string[]
    /** When set, attach the rows as evidence to this existing event instead of creating a new one. */
    eventId?: string
  }) => Promise<{ id: string }>
  wsIocList: (wsId: string) => Promise<CsvIoc[]>
  /** Content-based IOC↔event links: which events' evidence rows actually contain each IOC value. */
  wsIocEventLinks: (wsId: string) => Promise<Array<{ iocId: string; eventIds: string[] }>>
  wsIocDelete: (wsId: string, id: string) => Promise<null>
  wsIocClear: (wsId: string) => Promise<null>
  wsInvestigationGet: (wsId: string) => Promise<CsvInvestigation>
  wsInvestigationSetPlan: (wsId: string, plan: CsvPlanStep[]) => Promise<null>
  wsInvestigationSetNotes: (wsId: string, notes: string) => Promise<null>
  wsConversationList: (wsId: string) => Promise<CsvConversationMeta[]>
  wsConversationGet: (wsId: string, id: string) => Promise<CsvConversation | null>
  wsConversationUpsert: (
    wsId: string,
    conv: { id: string; title?: string; turns: unknown[] }
  ) => Promise<{ updatedAt: number } | null>
  wsConversationRename: (wsId: string, id: string, title: string) => Promise<null>
  wsConversationDelete: (wsId: string, id: string) => Promise<null>
  wsTagSet: (wsId: string, sourceId: number, rids: number[], tag: string | null) => Promise<null>
  wsTagByFilter: (
    wsId: string,
    sourceId: number,
    filters: CsvFilter[] | undefined,
    search: string | undefined,
    tag: string | null
  ) => Promise<{ count: number }>
  /** Per-tag counts for the active source under the current filtered view (tag filter excluded). */
  tagCounts: (tabId: string, filters?: CsvFilter[], search?: string) => Promise<Array<{ tag: string; cnt: number }>>
  cancel: (tabId: string) => Promise<{ canceled: boolean }>
  query: (tabId: string, opts: CsvQueryOpts) => Promise<CsvRowsResult>
  count: (
    tabId: string,
    reqId: number,
    filters?: CsvFilter[],
    search?: string
  ) => Promise<CsvCountResult>
  distinct: (
    tabId: string,
    col: string,
    filters?: CsvFilter[],
    limit?: number,
    reqId?: number
  ) => Promise<{ rows: CsvDistinctRow[]; total: number; truncated: boolean } | { canceled: true }>
  distinctCancel: (tabId: string) => Promise<null>
  onDistinctProgress: (cb: (p: CsvDistinctProgress) => void) => () => void
  /** Sweep a source for an intel set → record sightings; resolves with counts or { canceled }. */
  sweep: (
    tabId: string,
    reqId: number,
    entries: Array<{ value: string; kind: string }>,
    columns?: string[],
    mode?: 'replace' | 'add'
  ) => Promise<{ sightings: number; hits: number } | { canceled: true }>
  sweepCancel: (tabId: string) => Promise<null>
  onSweepProgress: (cb: (p: CsvSweepProgress) => void) => () => void
  sightingList: (wsId: string, sourceId: number) => Promise<Array<{ rid: number; indicator: string; kind: string }>>
  sightingSummary: (wsId: string, sourceId: number) => Promise<Array<{ indicator: string; kind: string; count: number }>>
  /** Workspace-wide sighting rollup grouped by indicator → the files it was seen in (cross-file view). */
  sightingsAll: (
    wsId: string
  ) => Promise<
    Array<{
      indicator: string
      kind: string
      total: number
      sources: Array<{ sourceId: number; sourceName: string; count: number; rids: number[] }>
    }>
  >
  sightingClear: (wsId: string, sourceId: number, opts?: { indicator?: string; rid?: number }) => Promise<null>
  /** Workspace-wide free-string "find in files": which sources contain `term` (+ matching rowids for
   *  click-to-jump). `group`: omitted = all sources; null = only ungrouped; a string = that group only. */
  findInFiles: (
    wsId: string,
    term: string,
    opts?: { group?: string | null; ridCap?: number }
  ) => Promise<
    Array<{
      sourceId: number
      name: string
      group: string | null
      rowCount: number
      matchCount: number
      rids: number[]
      capped: boolean
    }>
  >
  longest: (tabId: string, col: string) => Promise<string>
  /** 0-based ordinal of a row (by rowid) in the current unsorted filtered view, or -1. */
  locate: (tabId: string, rid: number, filters: CsvFilter[] | undefined, search: string | undefined) => Promise<number>
  values: (
    tabId: string,
    col: string,
    filters?: CsvFilter[]
  ) => Promise<{ values: string[]; truncated: boolean }>
  stats: (tabId: string, col: string) => Promise<CsvColumnStats>
  /** Stream every row of the current view (filters+search+sort) to a CSV file via a save dialog. */
  export: (
    tabId: string,
    defaultName: string | undefined,
    opts: { filters?: CsvFilter[]; search?: string; sort?: CsvSort; columns?: string[] }
  ) => Promise<{ canceled: true } | { path: string; rows: number }>
  close: (tabId: string) => Promise<null>
  onProgress: (cb: (p: CsvProgress) => void) => () => void
  onCountProgress: (cb: (p: CsvCountProgress) => void) => () => void
}

// ---- Enrichment (threat-intel) ----
export type IndicatorKind = 'ipv4' | 'ipv6' | 'domain' | 'url' | 'email' | 'md5' | 'sha1' | 'sha256'
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
export interface EnrichBulkStats {
  cacheHits: number
  cacheMisses: number
  networkLookups: number
  rateLimitSleeps: number
  retryCount: number
  count429: number
  avgLatencyMs: number
}
export type EnrichBulkResult = {
  rows: EnrichResultRow[]
  canceled?: boolean
  aborted?: 'quota'
  message?: string
  stats?: EnrichBulkStats
}
export type VtSetKeyResult =
  | { ok: true; tier?: 'free' | 'premium'; dailyQuota?: number | null; requestsPerMinute?: number }
  | { ok: false; error: string }
export interface VtSettings {
  requestsPerMinute: number
  dailyQuota: number | null
}
export interface EnrichCachedRow {
  provider: string
  indicator: string
  kind: string
  status: 'ok' | 'notfound' | 'error'
  fields: Record<string, string>
  fetchedAt: number
}

export interface EnrichSetupProgress {
  editionId: string
  received: number
  total: number
}
export type MaxmindSetupResult =
  | { ok: true; installed: Array<{ editionId: string; path: string }> }
  | { ok: false; error: string }

export interface EnrichApi {
  providers: () => Promise<EnrichProviderInfo[]>
  pickMmdb: () => Promise<string | null>
  hasKey: () => Promise<boolean>
  maxmindSetup: (key: string | undefined, editions?: string[]) => Promise<MaxmindSetupResult>
  vtHasKey: () => Promise<boolean>
  vtSetKey: (key: string) => Promise<VtSetKeyResult>
  vtGetSettings: () => Promise<VtSettings>
  onSetupProgress: (cb: (p: EnrichSetupProgress) => void) => () => void
  defaultDb: () => Promise<string>
  openDb: () => Promise<string | null>
  newDb: () => Promise<string | null>
  bulk: (reqId: number, dbPath: string, providerId: string, items: EnrichItem[]) => Promise<EnrichBulkResult>
  cancel: () => Promise<null>
  cacheCount: (dbPath: string) => Promise<number>
  cacheGet: (dbPath: string, indicators: string[]) => Promise<EnrichCachedRow[]>
  cacheDump: (dbPath: string, limit?: number) => Promise<EnrichCachedRow[]>
  cacheDelete: (dbPath: string, indicators: string[]) => Promise<null>
  onProgress: (cb: (p: EnrichProgress) => void) => () => void
  openExternal: (url: string) => Promise<null>
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
export interface WatchlistApi {
  list: () => Promise<WatchlistInfo[]>
  entries: (id: number) => Promise<string[]>
  create: (name: string, kind: WatchlistKind, color?: string | null) => Promise<WatchlistInfo>
  rename: (id: number, name: string) => Promise<null>
  remove: (id: number) => Promise<null>
  replace: (id: number, text: string) => Promise<{ added: number; skipped: string[] }>
}

// ---- AI assistant ----
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
/** A model choice offered in Settings. An empty id means "use the Claude Code default". */
export interface ClaudeModelOption {
  id: string
  label: string
  hint: string
}
/** One column of the active workspace source, as the agent context sends it. */
export interface AiWsColumn {
  name: string
  original: string
  time?: string
}
/** The active-workspace context the renderer sends with each chat turn. */
export interface AiWsSource {
  sourceId: number
  tabId: string
  name: string
  columns: AiWsColumn[]
  rowCount: number
}
export interface AiWsCtx {
  hasWorkspace: boolean
  wsId?: string
  workspaceName?: string
  activeSourceId?: number | null
  sources: AiWsSource[]
  intelDbPath?: string
}
/** A turn in the chat history the renderer keeps (user prompts + the model's final replies). */
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
  | { reqId: number; type: 'action'; actionId: string; kind: string; summary: string; detail?: string; tag?: string; count?: number }
  | { reqId: number; type: 'model'; model: string }
  | { reqId: number; type: 'done'; truncated?: boolean }
  | { reqId: number; type: 'error'; message?: string }
export interface AiChatRequest {
  reqId: number
  messages: AiChatMessage[]
  wsCtx: AiWsCtx
  providerId?: string
  model?: string
}
export interface AiApi {
  getConfig: () => Promise<AiConfig>
  setConfig: (cfg: { model?: string }) => Promise<{ ok: boolean }>
  listModels: () => Promise<ClaudeModelOption[]>
  chat: (req: AiChatRequest) => Promise<{ ok: boolean }>
  cancel: (reqId: number) => Promise<null>
  actionResult: (actionId: string, approved: boolean) => Promise<null>
  onEvent: (cb: (p: AiEventPayload) => void) => () => void
}

/** A message a popout relays to the main window, which owns the grid + workspace doc state. */
export type PopoutMessage =
  | { type: 'pivot'; wsId: string; sourceId: number; rids: number[] }
  | { type: 'pivotValue'; wsId: string; value: string; source?: string }
  | { type: 'buildTimeline'; wsId: string; header: string[]; rows: string[][] }
  | { type: 'applyGroup'; wsId: string; sourceId: number; group: string | null }
  | { type: 'refresh'; wsId: string; what: 'findings' | 'tags' | 'iocs' | 'investigation' }
export interface PopoutApi {
  open: (kind: string, payload: unknown) => Promise<null>
  relay: (msg: PopoutMessage) => void
  onRelay: (cb: (p: PopoutMessage) => void) => () => void
}

export interface Api {
  openFile: () => Promise<{
    name: string
    content: string
    size: number
    tooLarge?: boolean
  } | null>
  saveFile: (content: string, defaultName?: string) => Promise<string | null>
  csv: CsvApi
  enrich: EnrichApi
  ai: AiApi
  popout: PopoutApi
  watchlist: WatchlistApi
}

declare global {
  interface Window {
    api: Api
  }
}
