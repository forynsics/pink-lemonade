// Renderer-side mirror of the csv:* IPC shapes (see src/preload/index.d.ts CsvApi).
// Kept here so renderer modules import from one place without reaching into preload.

export type TimeKind = 'iso' | 'epoch_s' | 'epoch_ms'

export interface CsvColumn {
  name: string // c0..cN
  original: string
  /** Detected timestamp kind, if this is a time column. */
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
