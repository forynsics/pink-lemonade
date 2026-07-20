// Renderer-side mirror of the csv:* IPC shapes (see src/preload/index.d.ts CsvApi).
// Kept here so renderer modules import from one place without reaching into preload.

export type TimeKind = 'iso' | 'epoch_s' | 'epoch_ms'

export interface CsvColumn {
  name: string // c0..cN
  original: string
  /** Detected timestamp kind, if this is a time column. */
  time?: TimeKind
  /** True when the column's values are numbers, so sorting compares them numerically rather than
   *  as text (0, 1, 2 … not 0, 1, 10). Decided once at ingest so the grid and the agent agree. */
  numeric?: boolean
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
 * A SYSTEM or ACCOUNT — a subject of the case, as opposed to an IOC you would hunt or share.
 *
 * `origin` and `collected` are INDEPENDENT axes. Evidenced + not collected is the one the panel calls
 * out: a host the data names whose artifacts nobody ever pulled.
 */
export interface CsvEntity {
  id: string
  kind: 'system' | 'account'
  name: string
  origin: 'evidenced' | 'asserted'
  status: 'compromised' | 'suspected' | 'cleared' | 'unknown'
  role: string | null
  notes: string | null
  /** Do we hold its data? Derived from the sources — curation cannot fake it. */
  collected: boolean
  eventCount: number
  evidenced: boolean
  aliases: string[]
  groundingCount: number
  /** HOW we concluded we hold its data: 'group' (it IS a source group), 'shortName' (an FQDN whose
   *  short name matches one — an inference), 'alias' (a confirmed alias is one). Null when we don't. */
  collectedVia: 'group' | 'shortName' | 'alias' | null
  /** Who added it — shown as an AI/Analyst badge. Null when it came out of the data itself. */
  actor: 'ai' | 'analyst' | null
  /** Null when nothing is curated — i.e. it exists only in the derived spine. */
  createdAt: number | null
  updatedAt: number | null
}

/** A LEAD: an AI hypothesis/inference (unproven), grounded in real rows — shown in the Investigation
 *  panel for the analyst to pursue, promote to an event, or dismiss. Kept out of the Constellation. */
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
