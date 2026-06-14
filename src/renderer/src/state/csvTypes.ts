// Renderer-side mirror of the csv:* IPC shapes (see src/preload/index.d.ts CsvApi).
// Kept here so renderer modules import from one place without reaching into preload.

export interface CsvColumn {
  name: string // c0..cN
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

export type CsvFilter =
  | { col: string; op: 'eq' | 'like'; value: string }
  | { col: string; op: 'in'; values: string[] }

export interface CsvQueryOpts {
  sort?: CsvSort
  filters?: CsvFilter[]
  /** Global quick-find term: matches any column (ANDed with filters). */
  search?: string
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
