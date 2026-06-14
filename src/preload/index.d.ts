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
  | { op: 'tag'; tag: string }
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
  wsRemoveSource: (wsId: string, sourceId: number) => Promise<null>
  wsTagList: (wsId: string, sourceId: number) => Promise<CsvRowTag[]>
  wsTagSet: (wsId: string, sourceId: number, rids: number[], tag: string | null) => Promise<null>
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
    limit?: number
  ) => Promise<{ rows: CsvDistinctRow[]; total: number; truncated: boolean }>
  longest: (tabId: string, col: string) => Promise<string>
  values: (
    tabId: string,
    col: string,
    filters?: CsvFilter[]
  ) => Promise<{ values: string[]; truncated: boolean }>
  stats: (tabId: string, col: string) => Promise<CsvColumnStats>
  close: (tabId: string) => Promise<null>
  onProgress: (cb: (p: CsvProgress) => void) => () => void
  onCountProgress: (cb: (p: CsvCountProgress) => void) => () => void
}

export interface Api {
  openFile: () => Promise<{
    name: string
    content: string
    size: number
    tooLarge?: boolean
  } | null>
  saveFile: (content: string) => Promise<string | null>
  csv: CsvApi
}

declare global {
  interface Window {
    api: Api
  }
}
