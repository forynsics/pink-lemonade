export type TimeKind = 'iso' | 'epoch_s' | 'epoch_ms'
export interface CsvColumn {
  name: string
  original: string
  time?: TimeKind
  /** Values are numbers — sort must compare numerically. Decided at ingest. */
  numeric?: boolean
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
/** A row's AI-accountability mark: rid = positional rowid, note = what the agent asserted. */
export interface CsvAiMark {
  rid: number
  note: string | null
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
  /** The agent's per-row rationale for this evidence item; null when none. */
  why?: string | null
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
  /** What is UNSETTLED about this event, in words. Evidence proves it OCCURRED; this says what the
   *  occurrence does not settle — a contested attribution on an otherwise certain execution. Null
   *  means nothing was contested, NOT that the reading is confirmed. */
  uncertainty: string | null
  /** Host(s) this happened on, derived from the group of every source its evidence cites. An ARRAY
   *  because a lateral-movement event legitimately has evidence on both ends of the connection. */
  hosts: string[]
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
/** A LEAD: an AI hypothesis/inference (unproven), grounded in real rows, shown in the Investigation
 *  panel for the analyst to pursue, promote to an event, or dismiss. */
export interface CsvLeadGrounding {
  id: number
  sourceId: number
  sourceName: string
  matched: string
  count: number
  rids: number[]
  tsMin: number | null
  tsMax: number | null
}
export interface CsvLead {
  id: string
  statement: string
  whyUncertain: string | null
  nextStep: string | null
  createdAt: number
  /** open | refuted | superseded | promoted. A resolved lead is KEPT (a ruled-out hypothesis is a
   *  durable record); only its rendering changes. */
  status: 'open' | 'refuted' | 'superseded' | 'promoted'
  resolution: string | null
  resolvedAt: number | null
  supersededBy: string | null
  promotedEventId: string | null
  grounding: CsvLeadGrounding[]
}
/**
 * One adjudicable claim in the Case Report — an event, lead, proven absence, evidence gap or entity
 * verdict, plus what the analyst decided about it. Assembled on read from the stores that hold the
 * claims; the verdict is the only thing this view owns.
 */
export interface CsvCaseReportItem {
  kind: 'event' | 'lead' | 'negative' | 'entity'
  id: string
  title: string
  detail: string | null
  hosts: string[]
  actor: 'ai' | 'analyst'
  verdict: 'pending' | 'approved' | 'rejected'
  reason: string | null
  reviewedAt: number | null
  support: number
  flags: string[]
}
/**
 * A SYSTEM or ACCOUNT in the case — a subject that carries state, as opposed to an IOC you would hunt.
 *
 * `origin` and `collected` are INDEPENDENT. The pairing that matters most is evidenced + not collected:
 * a host the data names but whose triage package nobody ever pulled. That's a collection request.
 */
export interface CsvEntity {
  id: string
  kind: 'system' | 'account'
  name: string
  /** evidenced = the case's own data (or cited grounding) backs it; asserted = someone added it. */
  origin: 'evidenced' | 'asserted'
  status: 'compromised' | 'suspected' | 'cleared' | 'unknown'
  role: string | null
  notes: string | null
  /** Do we hold this entity's data? Derived from the sources — never stored, so it can't drift. */
  collected: boolean
  eventCount: number
  evidenced: boolean
  aliases: string[]
  groundingCount: number
  /** HOW we concluded we hold its data: 'group' (it IS a source group), 'shortName' (an FQDN whose
   *  short name matches one — an inference), 'alias' (a confirmed alias is one). Null when we don't. */
  collectedVia: 'group' | 'shortName' | 'alias' | null
  /** Who added it. Null when the entity came out of the case data rather than from a person/agent. */
  actor: 'ai' | 'analyst' | null
  /** Null when nothing has been curated — i.e. the entity exists only in the derived spine. */
  createdAt: number | null
  updatedAt: number | null
}
export interface CsvEntityPatch {
  kind: 'system' | 'account'
  name: string
  status?: CsvEntity['status']
  role?: string | null
  notes?: string | null
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
/** A row's tag in a source: rid = positional rowid, tag = one of the tag category ids. */
export interface CsvRowTag {
  rid: number
  tag: string
  /** Provenance: null for the analyst's own tags, 'ai' for agent-applied ones. */
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
  wsAgentSqlLog: (
    wsId: string,
    limit?: number
  ) => Promise<Array<{ id: number; ranAt: number; sql: string; outcome: 'ok' | 'refused' | 'error'; rowCount?: number; elapsedMs?: number; detail?: string | null }>>
  wsGetDir: () => Promise<string>
  wsSetDir: (dir: string) => Promise<string>
  wsPickDir: () => Promise<string | null>
  wsGetEvidenceRoot: () => Promise<string | null>
  wsSetEvidenceRoot: (dir: string | null) => Promise<string | null>
  wsPickEvidenceRoot: () => Promise<string | null>
  wsTagList: (wsId: string, sourceId: number) => Promise<CsvRowTag[]>
  wsAiMarkList: (wsId: string, sourceId: number) => Promise<CsvAiMark[]>
  wsAiMarkClear: (wsId: string, sourceId: number) => Promise<null>
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
  wsLeadList: (wsId: string) => Promise<CsvLead[]>
  wsLeadDelete: (wsId: string, id: string) => Promise<null>
  wsLeadClear: (wsId: string) => Promise<null>
  /** Promote a lead to a real event (its grounding becomes evidence). Returns the new event id. */
  wsLeadPromote: (wsId: string, id: string) => Promise<string | null>
  /** Systems + Accounts: the derived spine overlaid with curated records. */
  /** The whole case as one adjudicable list — events, leads, negatives, entity verdicts. */
  wsCaseReport: (wsId: string) => Promise<CsvCaseReportItem[]>
  /** Set an analyst verdict on a claim. Rejecting requires a reason (enforced in the store). */
  wsCaseReview: (wsId: string, kind: string, id: string, verdict: string, reason?: string | null) => Promise<{ ok: boolean; error?: string }>
  wsEntityList: (wsId: string) => Promise<CsvEntity[]>
  /** Create or update a curated entity. Returns its id, or null if the name/kind was unusable. */
  wsEntityUpsert: (wsId: string, patch: CsvEntityPatch) => Promise<string | null>
  /** Removes the CURATED record; an entity the case's own data names survives in the derived spine. */
  wsEntityDelete: (wsId: string, id: string) => Promise<null>
  wsEntityAliasAdd: (wsId: string, id: string, alias: string) => Promise<boolean>
  /** Record that two names ARE (or are NOT) the same entity. Merging folds the other record in. */
  wsEntityLink: (
    wsId: string,
    kind: 'system' | 'account',
    primary: string,
    other: string,
    same: boolean,
    reason?: string
  ) => Promise<{ linked: boolean; id: string; merged: boolean; aliases: string[] } | null>
  wsEntityAliasRemove: (wsId: string, id: string, alias: string) => Promise<null>
  wsInvestigationGet: (wsId: string) => Promise<CsvInvestigation>
  wsInvestigationSetPlan: (wsId: string, plan: CsvPlanStep[]) => Promise<null>
  wsInvestigationSetNotes: (wsId: string, notes: string) => Promise<null>
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
  /** The row that just finished — main emits it so the grid can render results live as they land. */
  row?: EnrichResultRow
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
export type SetProviderKeyResult = { ok: true } | { ok: false; error: string }
/** How to render a provider's key field. Carries no secret and no storage detail. */
export interface ProviderKeySpec {
  label: string
  help: string
  signupUrl?: string
}
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
  maxmindSetup: (key: string | undefined, editions?: string[]) => Promise<MaxmindSetupResult>
  keySpecs: () => Promise<Record<string, ProviderKeySpec>>
  keyStatus: () => Promise<Record<string, boolean>>
  setProviderKey: (providerId: string, key: string) => Promise<SetProviderKeyResult>
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

// ---- Workspace context (published to the terminal-driven MCP surface) ----
/** One column of the active workspace source. */
export interface AiWsColumn {
  name: string
  original: string
  time?: string
}
/** One source of the active workspace. */
export interface AiWsSource {
  sourceId: number
  tabId: string
  name: string
  columns: AiWsColumn[]
  rowCount: number
  /** Analyst-assigned grouping label (host/system/origin); null = ungrouped. */
  group?: string | null
  /** True for a derived source (the materialized Timeline) — main excludes it from the agent's triage
   *  coverage (ai/coverage.ts). Set by the renderer; both ends relied on it while the contract omitted it. */
  derived?: boolean
}
/** The focused workspace the renderer publishes so the terminal drives what the analyst has open. */
export interface AiWsCtx {
  hasWorkspace: boolean
  wsId?: string
  workspaceName?: string
  activeSourceId?: number | null
  sources: AiWsSource[]
  intelDbPath?: string
}

/** Status of the localhost MCP server the analyst's own Claude Code connects to. */
export interface McpStatus {
  running: boolean
  port: number | null
  token: string | null
  url: string | null
  error?: string
}
export interface McpProvisionResult {
  dir: string
  port: number | null
}
export interface McpApi {
  status: () => Promise<McpStatus>
  /** Publish the focused workspace so the terminal drives what the analyst has open. */
  setActiveWorkspace: (ws: AiWsCtx) => void
  defaultFolder: () => Promise<string>
  pickFolder: () => Promise<string | null>
  setupFolder: (dir?: string) => Promise<McpProvisionResult>
  openFolder: (dir: string) => Promise<null>
  /** A terminal tool changed workspace state — reload the review panels. Returns a disposer. */
  onMutated: (cb: (p: { wsId?: string; tool: string }) => void) => () => void
  onOpenRequest: (cb: (p: { wsId: string; dbPath: string; name: string }) => void) => () => void
}

/** A message a popout relays to the main window, which owns the grid + workspace doc state. */
export type PopoutMessage =
  | { type: 'pivot'; wsId: string; sourceId: number; rids: number[] }
  | { type: 'buildTimeline'; wsId: string; header: string[]; rows: string[][] }
  | { type: 'applyGroup'; wsId: string; sourceId: number; group: string | null }
  | { type: 'refresh'; wsId: string; what: 'events' | 'tags' | 'iocs' | 'investigation' }
  | { type: 'openClaim'; wsId: string; kind: string; id: string }
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
  mcp: McpApi
  popout: PopoutApi
  watchlist: WatchlistApi
}

declare global {
  interface Window {
    api: Api
  }
}
