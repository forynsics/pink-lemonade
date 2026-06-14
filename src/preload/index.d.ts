export interface CsvColumn {
  name: string
  original: string
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
export interface CsvFilter {
  col: string
  op: 'eq' | 'like'
  value: string
}
export interface CsvQueryOpts {
  sort?: CsvSort
  filters?: CsvFilter[]
  limit: number
  offset: number
}
export interface CsvRowsResult {
  rows: string[][]
  total: number
}
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
  distinct: (
    tabId: string,
    col: string,
    filters?: CsvFilter[],
    limit?: number
  ) => Promise<{ rows: CsvDistinctRow[]; truncated: boolean }>
  values: (
    tabId: string,
    col: string,
    filters?: CsvFilter[]
  ) => Promise<{ values: string[]; truncated: boolean }>
  stats: (tabId: string, col: string) => Promise<CsvColumnStats>
  close: (tabId: string) => Promise<null>
  onProgress: (cb: (p: CsvProgress) => void) => () => void
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
