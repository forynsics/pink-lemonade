import type { WorkflowStep } from './workflow'
import type { CsvColumn } from './csvTypes'
import type { EnrichItem } from './enrichTypes'

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

/** One imported CSV (a source) inside a workspace. Metadata only — rows live in the db. */
export interface WorkspaceSource {
  sourceId: number
  name: string
  columns: CsvColumn[]
  rowCount: number
  /** Absolute path the file was imported from — used to detect re-imports (optional on old docs). */
  originalPath?: string
  /** Analyst-assigned grouping label (host/system/origin the evidence belongs to); null/absent = ungrouped. */
  group?: string | null
  /** Column names (`c<n>`) hidden from the grid — display-only, persisted so it survives a reload. */
  hiddenColumns?: string[]
}

/** A workspace: one persistent .workspace SQLite db holding many sources. */
export interface WorkspaceDoc extends DocBase {
  kind: 'workspace'
  wsId: string
  dbPath: string
  sources: WorkspaceSource[]
  activeSourceId: number | null
  /** Which intel this workspace uses: 'global' (app-wide Global Intel) or 'workspace' (its own
   *  sibling .intel.db). Source of truth is ws_meta; mirrored here for the open doc. */
  intelMode: 'global' | 'workspace'
  /** True after a reload: the workspace db isn't open in main yet, so it must be re-opened by path. */
  needsReopen?: boolean
  /** Set if re-opening the workspace db by path failed (file missing/moved). */
  reopenFailed?: boolean
}

/** The Enrichment tab: a list of indicators to bulk-look-up against a provider. Results aren't
 * stored here — they re-read from the app-wide cache DB instantly on open, so only the (small)
 * indicator list + chosen provider persist. There is at most one of these at a time. */
export interface EnrichmentDoc extends DocBase {
  kind: 'enrichment'
  indicators: EnrichItem[]
  /** The paste box's text (small, persisted). "Send to Enrichment" appends here; "Add" consumes it. */
  draft: string
  /** Path to the intel DB file this tab reads/writes (the modular cache). Empty = resolve to the
   *  default DB at runtime. `name` (DocBase) is the DB's display label, shown in the tab + header. */
  dbPath: string
  /** User's preferred provider (bucket) order. Providers not listed render after, first-seen. */
  providerOrder?: string[]
  /** User's preferred field-column order per provider. Fields not listed render after. */
  fieldOrder?: Record<string, string[]>
  /** Persisted Intel grid view state, keyed by TanStack column id (stable across sessions while
   *  providers/fields are unchanged): column widths, hidden columns, and the (multi-)sort list. */
  colSizing?: Record<string, number>
  colVisibility?: Record<string, boolean>
  sorting?: Array<{ id: string; desc: boolean }>
}

export type PinkDoc = ScratchDoc | WorkspaceDoc | EnrichmentDoc

export interface DocsState {
  docs: PinkDoc[]
  activeId: string
}

/** Shape returned by the ws:* IPC (mirrors preload WorkspaceInfo). */
export interface WorkspaceInfo {
  wsId: string
  dbPath: string
  name: string
  sources: WorkspaceSource[]
  intelMode: 'global' | 'workspace'
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

export function createEnrichmentDoc(name = 'Enrichment', dbPath = ''): EnrichmentDoc {
  return { id: newId(), name, kind: 'enrichment', indicators: [], draft: '', dbPath }
}

export function createWorkspaceDoc(info: WorkspaceInfo): WorkspaceDoc {
  return {
    id: newId(),
    name: info.name,
    kind: 'workspace',
    wsId: info.wsId,
    dbPath: info.dbPath,
    sources: info.sources,
    activeSourceId: info.sources[0]?.sourceId ?? null,
    intelMode: info.intelMode
  }
}

/** Load persisted documents from the previous session, or null if none/invalid. */
export function loadDocs(): DocsState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { docs: unknown[]; activeId: string }
    if (!Array.isArray(parsed.docs) || parsed.docs.length === 0) return null
    // Drop pre-workspace 'csv' docs (their per-file dbs are obsolete — re-import into a workspace).
    const docs = parsed.docs.map(migrate).filter((d): d is PinkDoc => d != null)
    if (docs.length === 0) return null
    const activeOk = docs.some((d) => d.id === parsed.activeId)
    return { docs, activeId: activeOk ? parsed.activeId : docs[0].id }
  } catch {
    return null
  }
}

/** Normalize a persisted doc into the current union; returns null for obsolete docs (dropped). */
function migrate(raw: unknown): PinkDoc | null {
  const d = raw as Record<string, unknown>
  if (d?.kind === 'csv') return null // obsolete single-file CSV doc — reset
  if (d?.kind === 'enrichment') {
    return {
      id: String(d.id),
      name: String(d.name ?? 'Enrichment'),
      kind: 'enrichment',
      indicators: Array.isArray(d.indicators) ? (d.indicators as EnrichItem[]) : [],
      draft: typeof d.draft === 'string' ? d.draft : '',
      dbPath: typeof d.dbPath === 'string' ? d.dbPath : '',
      providerOrder: Array.isArray(d.providerOrder) ? (d.providerOrder as string[]) : undefined,
      fieldOrder:
        d.fieldOrder && typeof d.fieldOrder === 'object' ? (d.fieldOrder as Record<string, string[]>) : undefined,
      colSizing: d.colSizing && typeof d.colSizing === 'object' ? (d.colSizing as Record<string, number>) : undefined,
      colVisibility:
        d.colVisibility && typeof d.colVisibility === 'object' ? (d.colVisibility as Record<string, boolean>) : undefined,
      sorting: Array.isArray(d.sorting) ? (d.sorting as Array<{ id: string; desc: boolean }>) : undefined
    }
  }
  if (d?.kind === 'workspace') {
    return {
      id: String(d.id),
      name: String(d.name ?? 'Workspace'),
      kind: 'workspace',
      wsId: String(d.wsId ?? ''),
      dbPath: String(d.dbPath ?? ''),
      sources: Array.isArray(d.sources) ? (d.sources as WorkspaceSource[]) : [],
      activeSourceId: typeof d.activeSourceId === 'number' ? d.activeSourceId : null,
      intelMode: d.intelMode === 'workspace' ? 'workspace' : 'global',
      needsReopen: true // main process is fresh after a restart — reopen the workspace db by path
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

/** Strip oversized inputs (scratch docs) before persisting; workspaces persist metadata only. */
function toPersisted(state: DocsState): DocsState {
  return {
    activeId: state.activeId,
    docs: state.docs.map((d) => {
      if (d.kind === 'workspace') return d // rows live in SQLite, never serialized
      if (d.kind === 'enrichment') return d // small indicator list; results live in the cache DB
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
