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
/** One piece of evidence for an event: rows in a source that corroborate it. */
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

/** One step of the AI investigation plan (an analyst-editable to-do / lead). */
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
  /** Global quick-find term: matches any column (ANDed with filters). */
  search?: string
  limit: number
  offset: number
}

export interface CsvRowsResult {
  rows: string[][]
  rids: number[]
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
/** One file a swept indicator was seen in, with the matching rids (for click-to-jump). */
export interface CsvSightingSourceHit {
  sourceId: number
  sourceName: string
  count: number
  rids: number[]
}
/** Workspace-wide sighting rollup: an indicator + every file it appears in (cross-file results view). */
export interface CsvSightingGroup {
  indicator: string
  kind: string
  total: number
  sources: CsvSightingSourceHit[]
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
