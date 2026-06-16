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
/** A row's tag in a source: rid = positional rowid, tag = one of the tag category ids. */
export interface CsvRowTag {
  rid: number
  tag: string
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
  pickDb: () => Promise<string | null>
  ingest: (tabId: string, path: string) => Promise<CsvOpenResult | null>
  open: (tabId: string, dbPath: string) => Promise<CsvOpenResult>
  deleteDb: (dbPath: string) => Promise<null>
  wsCreate: (wsId: string, name: string) => Promise<WorkspaceInfo>
  wsOpen: (wsId: string, dbPath: string) => Promise<WorkspaceInfo>
  wsClose: (wsId: string) => Promise<null>
  wsDelete: (dbPath: string) => Promise<null>
  wsAddSource: (wsId: string, path: string) => Promise<SourceInfo | null>
  wsRename: (wsId: string, name: string) => Promise<null>
  wsSetIntelMode: (wsId: string, mode: 'global' | 'workspace') => Promise<null>
  wsRemoveSource: (wsId: string, sourceId: number) => Promise<null>
  wsRenameSource: (wsId: string, sourceId: number, name: string) => Promise<null>
  wsGetDir: () => Promise<string>
  wsSetDir: (dir: string) => Promise<string>
  wsPickDir: () => Promise<string | null>
  wsTagList: (wsId: string, sourceId: number) => Promise<CsvRowTag[]>
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
  sightingClear: (wsId: string, sourceId: number, opts?: { indicator?: string; rid?: number }) => Promise<null>
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
    opts: { filters?: CsvFilter[]; search?: string; sort?: CsvSort }
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
export type EnrichBulkResult = { rows: EnrichResultRow[]; canceled?: boolean }
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
  watchlist: WatchlistApi
}

declare global {
  interface Window {
    api: Api
  }
}
