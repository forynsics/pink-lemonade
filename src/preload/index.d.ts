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
export interface CsvSort {
  col: string
  dir: 'asc' | 'desc'
  numeric?: boolean
}
export type CsvFilter =
  | { col: string; op: 'eq' | 'like' | 'neq'; value: string }
  | { col: string; op: 'in'; values: string[] }
  | { col: string; op: 'timearound'; value: string; tkind: TimeKind; deltaSec: number }
  | { col: string; op: 'timerange'; tkind: TimeKind; from?: number; to?: number }
export interface CsvQueryOpts {
  sort?: CsvSort
  filters?: CsvFilter[]
  search?: string
  limit: number
  offset: number
}
export interface CsvRowsResult {
  rows: string[][]
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
  ingest: (tabId: string, path: string) => Promise<CsvOpenResult | null>
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
