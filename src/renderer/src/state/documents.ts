import type { WorkflowStep } from './workflow'
import type { CsvColumn, CsvOpenResult } from './csvTypes'

interface DocBase {
  id: string
  name: string
}

/** The classic notepad (internally "scratch"): an input buffer + a workflow of tools. */
export interface ScratchDoc extends DocBase {
  kind: 'scratch'
  input: string
  steps: WorkflowStep[]
  /** True after load when the input was too large to persist last session (body not restored). */
  inputDropped?: boolean
}

/** A CSV table backed by a main-process SQLite db. Holds metadata only — rows live in the db. */
export interface CsvDoc extends DocBase {
  kind: 'csv'
  tabId: string
  sourceName: string
  columns: CsvColumn[]
  rowCount: number
  dbPath: string
  /** True after a reload: the persistent db isn't open in main yet, so it must be re-opened by path. */
  needsReopen?: boolean
  /** Set if re-opening the persistent db by path failed (file missing/moved). */
  reopenFailed?: boolean
}

export type PinkDoc = ScratchDoc | CsvDoc

export interface DocsState {
  docs: PinkDoc[]
  activeId: string
}

const STORAGE_KEY = 'pink-lemonade:docs'

// Inputs larger than this aren't written to localStorage — stringifying tens of MB on
// every edit blocks the main thread and blows the ~5MB quota. The tab + its workflow steps
// still persist; only the oversized body is dropped (flagged via inputDropped).
const PERSIST_INPUT_MAX = 1_000_000

export function newId(): string {
  return crypto.randomUUID()
}

export function createDoc(name: string): ScratchDoc {
  return { id: newId(), name, kind: 'scratch', input: '', steps: [] }
}

export function createCsvDoc(meta: CsvOpenResult): CsvDoc {
  return {
    id: newId(),
    name: meta.sourceName,
    kind: 'csv',
    tabId: meta.tabId,
    sourceName: meta.sourceName,
    columns: meta.columns,
    rowCount: meta.rowCount,
    dbPath: meta.dbPath
  }
}

/** Load persisted documents from the previous session, or null if none/invalid. */
export function loadDocs(): DocsState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { docs: unknown[]; activeId: string }
    if (!Array.isArray(parsed.docs) || parsed.docs.length === 0) return null
    return { docs: parsed.docs.map(migrate), activeId: parsed.activeId }
  } catch {
    return null
  }
}

/** Normalize a persisted doc into the current union (defaults missing kind to scratch). */
function migrate(raw: unknown): PinkDoc {
  const d = raw as Record<string, unknown>
  if (d?.kind === 'csv') {
    return {
      id: String(d.id),
      name: String(d.name ?? 'CSV'),
      kind: 'csv',
      tabId: String(d.tabId ?? ''),
      sourceName: String(d.sourceName ?? d.name ?? 'CSV'),
      columns: Array.isArray(d.columns) ? (d.columns as CsvColumn[]) : [],
      rowCount: Number(d.rowCount ?? 0),
      dbPath: String(d.dbPath ?? ''),
      needsReopen: true // main process is fresh after a restart — reopen the persistent db by path
    }
  }
  return {
    id: String(d.id),
    name: String(d.name ?? 'Untitled'),
    kind: 'scratch',
    input: typeof d.input === 'string' ? d.input : '',
    steps: Array.isArray(d.steps) ? (d.steps as WorkflowStep[]) : [],
    inputDropped: d.inputDropped === true
  }
}

/** Strip oversized inputs (scratch docs) before persisting; CSV docs persist metadata only. */
function toPersisted(state: DocsState): DocsState {
  return {
    activeId: state.activeId,
    docs: state.docs.map((d) => {
      if (d.kind === 'csv') return d // rows live in SQLite, never serialized
      return d.input.length > PERSIST_INPUT_MAX
        ? { ...d, input: '', inputDropped: true }
        : { ...d, inputDropped: false }
    })
  }
}

export function saveDocs(state: DocsState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toPersisted(state)))
  } catch {
    /* storage unavailable or over quota — non-fatal */
  }
}
