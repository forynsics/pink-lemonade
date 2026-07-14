import { useEffect, useRef, useState } from 'react'
import { Sun, Moon, Loader2, Info, Bot, Network, Fingerprint, Clock, ClipboardList, Crosshair, Search, Radar, Sparkles } from 'lucide-react'
import { Logo } from './components/Logo'
import { AiPanel } from './components/ai/AiPanel'
import { ConstellationPanel } from './components/ai/ConstellationPanel'
import { TimelinePanel } from './components/ai/TimelinePanel'
import { InvestigationPanel } from './components/ai/InvestigationPanel'
import { GlobalSightingsPanel } from './components/csv/GlobalSightingsPanel'
import { FindInFilesPanel } from './components/csv/FindInFilesPanel'
import { IocPanel } from './components/ai/IocPanel'
import { ToolPalette } from './components/ToolPalette'
import { ScratchEditor } from './components/ScratchEditor'
import { DocTabs } from './components/DocTabs'
import { Welcome } from './components/Welcome'
import { CsvViewer, type CsvViewerHandle, type TagSummary } from './components/csv/CsvViewer'
import { CsvPlaceholder } from './components/csv/CsvPlaceholder'
import { IntelSweepTargetDialog, type SweepTargetWorkspace } from './components/csv/IntelSweepTargetDialog'
import { FolderImportDialog, type FolderFile } from './components/csv/FolderImportDialog'
import { WorkspaceSidebar } from './components/csv/WorkspaceSidebar'
import { EnrichmentView } from './components/enrich/EnrichmentView'
import { getById, defaultOptions } from './tools/registry'
import { classifyIndicator } from './tools/ioc/classify'
import {
  createDoc,
  createEnrichmentDoc,
  createWorkspaceDoc,
  loadDocs,
  newId,
  saveDocs,
  type DocsState,
  type EnrichmentDoc,
  type PinkDoc,
  type ScratchDoc,
  type WorkspaceDoc,
  type WorkspaceSource
} from './state/documents'
import type { AiWsCtx, EnrichItem } from './state/enrichTypes'
import { TIMELINE_SOURCE_MARKER } from './state/timeline'
import { loadAiPrefs, saveAiPrefs } from './state/ai'
import { loadTheme, saveTheme, type Theme } from './state/theme'
import { addRecent, loadRecent, removeRecent, saveRecent, type RecentFile } from './state/recent'
import type { ToolOptions } from './tools/types'

/** Query key for a workspace source — must match the main process's sourceKey. */
function srcKey(wsId: string, sourceId: number): string {
  return `${wsId}:${sourceId}`
}

function initialDocs(): DocsState {
  const loaded = loadDocs()
  if (loaded) {
    const activeOk = loaded.docs.some((d) => d.id === loaded.activeId)
    return { docs: loaded.docs, activeId: activeOk ? loaded.activeId : loaded.docs[0].id }
  }
  // No saved tabs → open empty on the Home screen; the user explicitly creates the first tab.
  return { docs: [], activeId: '' }
}

/** True for Excel workbooks we ingest sheet-by-sheet (legacy binary .xls isn't supported). */
const isXlsx = (path: string): boolean => /\.xls[xm]$/i.test(path)

export default function App(): JSX.Element {
  const [{ docs, activeId }, setState] = useState<DocsState>(initialDocs)
  const [theme, setTheme] = useState<Theme>(loadTheme)
  // Tracks an in-flight CSV ingest (for the import overlay + cancel).
  const [csvImport, setCsvImport] = useState<{
    tabId: string
    name: string
    rows: number
    bytes: number
    total: number
    /** For a bulk (folder/multi-file) import: which file of how many is in progress. */
    index?: number
    count?: number
  } | null>(null)
  // Folder-import review: after scanning a folder, the analyst confirms which files to import.
  const [folderImport, setFolderImport] = useState<{
    name: string
    files: FolderFile[]
    target: { kind: 'new' } | { kind: 'active'; wsId: string; docId: string }
  } | null>(null)
  // Confirm re-importing a single file that's already a source in the workspace.
  const [reimport, setReimport] = useState<{ wsId: string; docId: string; path: string; sourceName: string } | null>(null)
  // Recently-opened CSV files (welcome-screen quick pivot) + whether the welcome screen is showing.
  const [recent, setRecent] = useState<RecentFile[]>(loadRecent)
  // The app opens on the Home/welcome screen by default (the user's saved tabs stay in the
  // tab bar; clicking one — or any open/new action — leaves Home).
  const [home, setHome] = useState<boolean>(true)
  // About dialog (app name, version, license).
  const [about, setAbout] = useState(false)
  // AI assistant pull-out (right-side chat). Open state is remembered across launches.
  const [aiOpen, setAiOpen] = useState<boolean>(() => loadAiPrefs().open)
  useEffect(() => {
    saveAiPrefs({ ...loadAiPrefs(), open: aiOpen })
  }, [aiOpen])
  // Constellation panel (the case graph of validated findings).
  const [constellationOpen, setConstellationOpen] = useState(false)
  const [timelineOpen, setTimelineOpen] = useState(false)
  const [findingsRev, setFindingsRev] = useState(0) // bump to reload events after the AI records one
  const [iocOpen, setIocOpen] = useState(false)
  const [iocRev, setIocRev] = useState(0) // bump to reload the IOC catalog after the AI records one
  const [investigationOpen, setInvestigationOpen] = useState(false)
  const [investigationRev, setInvestigationRev] = useState(0) // bump to reload the plan/notes after the AI updates them
  // Workspace-wide sightings results (the cross-file "where is it?" view); rev bumps after any sweep.
  const [globalSightingsOpen, setGlobalSightingsOpen] = useState(false)
  const [sightingsRev, setSightingsRev] = useState(0)
  const [findInFilesOpen, setFindInFilesOpen] = useState(false)
  // Cross-source pivot: jump the grid to a value's rows in a (possibly different) source.
  const [pendingFocus, setPendingFocus] = useState<{ wsDocId: string; sourceId: number; value?: string; rids?: number[]; token: number } | null>(null)
  const focusTokenRef = useRef(0)
  // Path to the seamless default intel DB (resolved once from main).
  const [enrichDefault, setEnrichDefault] = useState('')
  useEffect(() => {
    void window.api.enrich.defaultDb().then(setEnrichDefault)
  }, [])
  // Tag rollup of the active workspace source (for the sidebar Tags facets) + a handle to drive its
  // tag filter. Only the active source's viewer populates these.
  const [tagSummary, setTagSummary] = useState<TagSummary | null>(null)
  const tagApiRef = useRef<CsvViewerHandle | null>(null)
  // Intel-tab → sweep pivot. `pendingSweep` is delivered to the target source's CsvViewer (opens its
  // Sweep dialog pre-filled); `sweepPicker` holds the indicators while the target dialog is choosing;
  // `sweepNotice` covers the "no workspace to sweep into" case. Token makes repeat pivots distinct.
  const [pendingSweep, setPendingSweep] = useState<{ wsDocId: string; sourceId: number; values: string[]; token: number } | null>(null)
  const [sweepPicker, setSweepPicker] = useState<{ values: string[] } | null>(null)
  const [sweepNotice, setSweepNotice] = useState<string | null>(null)
  const sweepTokenRef = useRef(0)
  // The configurable workspace storage folder (Open-Workspace default + where new workspaces save).
  const [workspaceDir, setWorkspaceDirState] = useState('')
  useEffect(() => {
    void window.api.csv.wsGetDir().then(setWorkspaceDirState)
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    saveTheme(theme)
  }, [theme])

  // Live ingest progress for the active import.
  useEffect(() => {
    return window.api.csv.onProgress((p) => {
      setCsvImport((cur) =>
        cur && p.tabId === cur.tabId && p.phase !== 'done'
          ? { ...cur, rows: p.rows, bytes: p.bytes, total: p.total }
          : cur
      )
    })
  }, [])

  // Debounce persistence: typing fires this on every keystroke, and JSON.stringify of the
  // docs (even bounded by the size guard in saveDocs) shouldn't run per character.
  const saveTimer = useRef<number>()
  useEffect(() => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => saveDocs({ docs, activeId }), 500)
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
    }
  }, [docs, activeId])

  // May be undefined when no tabs are open (fresh start / closed the last tab) → Home screen shows.
  const active = docs.find((d) => d.id === activeId)
  // The Constellation / Timeline / Investigation / IOC surfaces are workspace-scoped — they read a
  // single workspace's events/findings/plan. Their toggles live in the workspace Search bar (so they
  // only exist where they have something to show); this flag keeps an already-open docked panel from
  // lingering after you switch to a non-workspace tab. The Assistant stays available everywhere.
  const inWorkspace = !home && active?.kind === 'workspace'

  function updateActive(fn: (d: PinkDoc) => PinkDoc): void {
    setState((s) => ({ ...s, docs: s.docs.map((d) => (d.id === s.activeId ? fn(d) : d)) }))
  }

  function patchScratch(patch: Partial<ScratchDoc>): void {
    updateActive((d) => (d.kind === 'scratch' ? { ...d, ...patch } : d))
  }

  // Patch a specific scratch doc by id (each mounted editor edits its own doc, not just the active).
  function patchScratchById(id: string, patch: Partial<ScratchDoc>): void {
    setState((s) => ({
      ...s,
      docs: s.docs.map((d) => (d.id === id && d.kind === 'scratch' ? { ...d, ...patch } : d))
    }))
  }

  function patchWorkspaceById(id: string, patch: Partial<WorkspaceDoc>): void {
    setState((s) => ({
      ...s,
      docs: s.docs.map((d) => (d.id === id && d.kind === 'workspace' ? { ...d, ...patch } : d))
    }))
  }

  function patchEnrichmentById(id: string, patch: Partial<EnrichmentDoc>): void {
    setState((s) => ({
      ...s,
      docs: s.docs.map((d) => (d.id === id && d.kind === 'enrichment' ? { ...d, ...patch } : d))
    }))
  }

  // ---- Enrichment: each tab is bound to an intel DB file (the modular cache). ----
  /** Display label for an intel DB: "Global Intel" for the default, else its filename (no .db). */
  function dbDisplayName(path: string): string {
    if (path && path === enrichDefault) return 'Global Intel'
    const base = path.split(/[\\/]/).pop() ?? 'intel'
    return base.replace(/\.db$/i, '') || 'intel'
  }

  /** A workspace's own intel DB = a sibling .intel.db next to its .workspace file. */
  function workspaceIntelPath(wsDbPath: string): string {
    return wsDbPath.replace(/\.workspace$/i, '') + '.intel.db'
  }

  /** Open (or focus — no duplicate tabs) an Intel tab bound to a specific intel DB file. */
  function openEnrichmentDb(dbPath: string, nameOverride?: string): void {
    setHome(false)
    setState((s) => {
      const existing = s.docs.find((d): d is EnrichmentDoc => d.kind === 'enrichment' && d.dbPath === dbPath)
      if (existing) return { ...s, activeId: existing.id }
      const doc = createEnrichmentDoc(nameOverride ?? dbDisplayName(dbPath), dbPath)
      return { docs: [...s.docs, doc], activeId: doc.id }
    })
  }

  /** Open the Intel tab a workspace uses (Global Intel, or its own Workspace Intel). */
  function openWorkspaceIntel(ws: WorkspaceDoc): void {
    if (ws.intelMode === 'workspace') openEnrichmentDb(workspaceIntelPath(ws.dbPath), `${ws.name} Intel`)
    else openEnrichmentDb(enrichDefault, 'Global Intel')
  }
  /** Switch a workspace between Global Intel and its own Workspace Intel (persists to ws_meta). */
  async function changeWorkspaceIntelMode(docId: string, wsId: string, mode: 'global' | 'workspace'): Promise<void> {
    await window.api.csv.wsSetIntelMode(wsId, mode)
    patchWorkspaceById(docId, { intelMode: mode })
  }

  /** New Enrichment tab on the seamless default intel DB. */
  async function openEnrichmentTab(): Promise<void> {
    const path = enrichDefault || (await window.api.enrich.defaultDb())
    if (!enrichDefault) setEnrichDefault(path)
    openEnrichmentDb(path)
  }
  /** Pick / create an intel DB → open it in its own tab. */
  async function openIntelDb(): Promise<void> {
    const path = await window.api.enrich.openDb()
    if (path) openEnrichmentDb(path)
  }
  async function newIntelDb(): Promise<void> {
    const path = await window.api.enrich.newDb()
    if (path) openEnrichmentDb(path)
  }

  /** Classify raw strings and drop the recognized ones into an Intel tab's paste box (the user
   *  reviews, then Add). Routes to `target` (a specific intel DB) or, by default, Global Intel.
   *  Tokenized so a blob, a line, or one cell all work. */
  function sendToEnrichment(values: string[], target?: { dbPath: string; name: string }): void {
    const seen = new Set<string>()
    const recognized: string[] = []
    for (const raw of values.flatMap((v) => v.split(/[\s,]+/))) {
      const v = raw.trim()
      if (!v || seen.has(v) || !classifyIndicator(v)) continue
      seen.add(v)
      recognized.push(v)
    }
    if (recognized.length === 0) return // nothing looked like an indicator
    setHome(false)
    const dbPath = target?.dbPath || enrichDefault
    const label = target?.name || 'Global Intel'
    setState((s) => {
      const existing = s.docs.find((d): d is EnrichmentDoc => d.kind === 'enrichment' && d.dbPath === dbPath)
      if (existing) {
        const lines = new Set(existing.draft.split(/\r?\n/).map((x) => x.trim()).filter(Boolean))
        const fresh = recognized.filter((v) => !lines.has(v))
        const draft = [existing.draft.trim(), ...fresh].filter(Boolean).join('\n')
        return {
          ...s,
          docs: s.docs.map((d) => (d.id === existing.id ? { ...existing, draft } : d)),
          activeId: existing.id
        }
      }
      const doc: EnrichmentDoc = { ...createEnrichmentDoc(label, dbPath), draft: recognized.join('\n') }
      return { docs: [...s.docs, doc], activeId: doc.id }
    })
  }

  /** Workspaces that can receive a sweep right now (open, reopened, with at least one source). */
  function sweepableWorkspaces(): SweepTargetWorkspace[] {
    return docs
      .filter((d): d is WorkspaceDoc => d.kind === 'workspace' && !d.needsReopen && d.sources.length > 0)
      .map((d) => ({ id: d.id, name: d.name, sources: d.sources.map((s) => ({ sourceId: s.sourceId, name: s.name })) }))
  }

  /** Mirror of sendToEnrichment: pivot selected Intel-tab indicators into a workspace sweep. With one
   *  eligible source, go straight to it; with several, ask which; with none, nudge to open a workspace. */
  function sweepFromIntel(values: string[]): void {
    const vals = values.map((v) => v.trim()).filter(Boolean)
    if (vals.length === 0) return
    const targets = sweepableWorkspaces()
    const sourceCount = targets.reduce((n, w) => n + w.sources.length, 0)
    if (sourceCount === 0) {
      setSweepNotice('Open a workspace and import a CSV first — a sweep marks rows in a workspace source.')
      return
    }
    if (sourceCount === 1) {
      startSweep(targets[0].id, targets[0].sources[0].sourceId, vals)
      return
    }
    setSweepPicker({ values: vals })
  }

  /** Make the target source active and hand its CsvViewer the indicators to pre-fill the Sweep dialog. */
  function startSweep(wsDocId: string, sourceId: number, values: string[]): void {
    setHome(false)
    setSweepPicker(null)
    setState((s) => ({
      ...s,
      activeId: wsDocId,
      docs: s.docs.map((d) => (d.id === wsDocId && d.kind === 'workspace' ? { ...d, activeSourceId: sourceId } : d))
    }))
    setPendingSweep({ wsDocId, sourceId, values, token: ++sweepTokenRef.current })
  }

  // ---- document operations ----
  function addDoc(): void {
    setHome(false)
    setState((s) => {
      const doc = createDoc(`Untitled ${s.docs.length + 1}`)
      return { docs: [...s.docs, doc], activeId: doc.id }
    })
  }

  function recordRecent(path: string, sourceName: string, rowCount: number): void {
    setRecent((list) => {
      const next = addRecent(list, { path, sourceName, rowCount, openedAt: Date.now() })
      saveRecent(next)
      return next
    })
  }

  function dropRecent(path: string): void {
    setRecent((list) => {
      const next = removeRecent(list, path)
      saveRecent(next)
      return next
    })
  }

  /** Import a CSV as a NEW workspace (the file becomes its first source). */
  async function newWorkspaceFromCsv(): Promise<void> {
    const picked = await window.api.csv.pick()
    if (!picked) return
    const wsId = newId()
    const ws = await window.api.csv.wsCreate(wsId, picked.sourceName)
    setHome(false)
    setCsvImport({ tabId: wsId, name: picked.sourceName, rows: 0, bytes: 0, total: 0 })
    let srcs: WorkspaceSource[] = []
    try {
      if (isXlsx(picked.path)) {
        srcs = (await window.api.csv.wsAddXlsx(wsId, picked.path)) ?? []
      } else {
        const src = await window.api.csv.wsAddSource(wsId, picked.path)
        srcs = src ? [src] : []
      }
    } finally {
      setCsvImport(null)
    }
    const doc = createWorkspaceDoc({ ...ws, sources: srcs })
    setState((s) => ({ docs: [...s.docs, doc], activeId: doc.id }))
    recordRecent(ws.dbPath, ws.name, srcs.reduce((a, src) => a + src.rowCount, 0))
  }

  /** New empty workspace (import sources into it afterwards). */
  async function newWorkspace(): Promise<void> {
    const wsId = newId()
    const n = docs.filter((d) => d.kind === 'workspace').length + 1
    const ws = await window.api.csv.wsCreate(wsId, `Workspace ${n}`)
    const doc = createWorkspaceDoc(ws)
    setHome(false)
    setState((s) => ({ docs: [...s.docs, doc], activeId: doc.id }))
    recordRecent(ws.dbPath, ws.name, 0)
  }

  /** Open an existing workspace db by path (activating it if already open — no duplicate tabs).
   *  Matches regardless of needsReopen: a restored-but-not-yet-reopened tab is still the same
   *  workspace, so we just activate it (the auto-reopen effect fires once it's the active doc). */
  async function openWorkspaceByPath(dbPath: string): Promise<void> {
    const existing = docs.find((d) => d.kind === 'workspace' && d.dbPath === dbPath)
    if (existing) {
      setHome(false)
      setState((s) => ({ ...s, activeId: existing.id }))
      return
    }
    try {
      const info = await window.api.csv.wsOpen(newId(), dbPath)
      const doc = createWorkspaceDoc(info)
      setHome(false)
      setState((s) => ({ docs: [...s.docs, doc], activeId: doc.id }))
      recordRecent(info.dbPath, info.name, info.sources.reduce((a, src) => a + src.rowCount, 0))
    } catch {
      dropRecent(dbPath) // file missing/moved — drop from the recent list
    }
  }

  async function openWorkspaceFile(): Promise<void> {
    const dbPath = await window.api.csv.pickDb()
    if (dbPath) await openWorkspaceByPath(dbPath)
  }

  /** Pick a new workspace storage folder (new workspaces save there; Open-Workspace defaults there). */
  async function changeWorkspaceDir(): Promise<void> {
    const dir = await window.api.csv.wsPickDir()
    if (!dir) return
    setWorkspaceDirState(await window.api.csv.wsSetDir(dir))
  }

  function openRecent(f: RecentFile): void {
    void openWorkspaceByPath(f.path)
  }

  /** Append one or more freshly-ingested sources to a workspace doc, activating the last. */
  /** Materialize the Timeline rows as a real source the grid can open (Build Timeline). Replaces any
   *  prior generated Timeline source and opens the new one. */
  async function buildTimelineSourceFor(docId: string, wsId: string, header: string[], rows: string[][]): Promise<void> {
    const src = await window.api.csv.wsBuildTimeline(wsId, header, rows)
    if (!src) return
    setState((s) => ({
      ...s,
      docs: s.docs.map((d) =>
        d.id === docId && d.kind === 'workspace'
          ? { ...d, sources: [...d.sources.filter((x) => x.originalPath !== TIMELINE_SOURCE_MARKER), src], activeSourceId: src.sourceId }
          : d
      )
    }))
  }

  function appendSources(docId: string, srcs: WorkspaceSource[]): void {
    if (srcs.length === 0) return
    setState((s) => ({
      ...s,
      docs: s.docs.map((d) =>
        d.id === docId && d.kind === 'workspace' ? { ...d, sources: [...d.sources, ...srcs], activeSourceId: srcs[srcs.length - 1].sourceId } : d
      )
    }))
  }

  /** Ingest one file as a new source (or, for an Excel workbook, one source per sheet) in a workspace.
   *  Dedup is checked by callers. */
  async function doSingleImport(wsId: string, docId: string, path: string, sourceName: string): Promise<void> {
    setCsvImport({ tabId: wsId, name: sourceName, rows: 0, bytes: 0, total: 0 })
    try {
      if (isXlsx(path)) {
        const srcs = await window.api.csv.wsAddXlsx(wsId, path)
        if (srcs) appendSources(docId, srcs)
      } else {
        const src = await window.api.csv.wsAddSource(wsId, path)
        if (src) appendSources(docId, [src])
      }
    } finally {
      setCsvImport(null)
    }
  }

  /** Add a CSV as a new source to the active workspace (sidebar "Import"). Warns on a re-import. */
  async function addSourceToActive(): Promise<void> {
    if (active?.kind !== 'workspace') return
    const picked = await window.api.csv.pick()
    if (!picked) return
    const { wsId, id: docId } = active
    if (active.sources.some((s) => s.originalPath && s.originalPath === picked.path)) {
      setReimport({ wsId, docId, path: picked.path, sourceName: picked.sourceName })
      return
    }
    await doSingleImport(wsId, docId, picked.path, picked.sourceName)
  }

  /** Ingest a list of files into a workspace as sources, one after another, updating the import
   *  overlay (file N of M) and appending each source as it lands. A file that fails to parse is
   *  skipped so one bad CSV doesn't abort a whole KAPE package. Returns the total rows ingested. */
  async function bulkAddToWorkspace(
    wsId: string,
    docId: string,
    files: Array<{ path: string; sourceName: string }>,
    group?: string | null
  ): Promise<number> {
    let totalRows = 0
    const grp = group && group.trim() ? group.trim() : null
    for (let i = 0; i < files.length; i++) {
      const f = files[i]
      setCsvImport({ tabId: wsId, name: f.sourceName, rows: 0, bytes: 0, total: 0, index: i + 1, count: files.length })
      try {
        // Excel workbooks yield one source per sheet; everything else is a single source.
        const landed = isXlsx(f.path) ? (await window.api.csv.wsAddXlsx(wsId, f.path)) ?? [] : [await window.api.csv.wsAddSource(wsId, f.path)].filter(Boolean)
        for (const raw of landed) {
          if (!raw) continue
          const added = grp ? { ...raw, group: grp } : raw
          totalRows += added.rowCount
          if (grp) await window.api.csv.wsSetSourceGroup(wsId, added.sourceId, grp)
          setState((s) => ({
            ...s,
            docs: s.docs.map((d) =>
              d.id === docId && d.kind === 'workspace' ? { ...d, sources: [...d.sources, added], activeSourceId: d.activeSourceId ?? added.sourceId } : d
            )
          }))
        }
      } catch {
        /* skip a file that fails to ingest and keep going */
      }
    }
    setCsvImport(null)
    return totalRows
  }

  /** Scan a folder of CSVs (e.g. a parsed KAPE package) and open the review dialog to pick which to
   *  import as ONE new workspace. */
  async function newWorkspaceFromFolder(): Promise<void> {
    const picked = await window.api.csv.pickFolder()
    if (!picked || picked.files.length === 0) return
    setFolderImport({ name: picked.name, files: picked.files, target: { kind: 'new' } })
  }

  /** Scan a folder and open the review dialog to import the chosen CSVs into the ACTIVE workspace. */
  async function importFolderToActive(): Promise<void> {
    if (active?.kind !== 'workspace') return
    const picked = await window.api.csv.pickFolder()
    if (!picked || picked.files.length === 0) return
    setFolderImport({ name: picked.name, files: picked.files, target: { kind: 'active', wsId: active.wsId, docId: active.id } })
  }

  /** Confirm the folder-import selection → create/locate the workspace and ingest the chosen files,
   *  optionally assigning them all one group (e.g. the host the package came from). */
  async function runFolderImport(selected: FolderFile[], group: string | null): Promise<void> {
    const job = folderImport
    setFolderImport(null)
    if (!job || selected.length === 0) return
    if (job.target.kind === 'new') {
      const wsId = newId()
      const ws = await window.api.csv.wsCreate(wsId, job.name || 'Imported')
      const doc = createWorkspaceDoc(ws)
      setHome(false)
      setState((s) => ({ docs: [...s.docs, doc], activeId: doc.id }))
      const rows = await bulkAddToWorkspace(wsId, doc.id, selected, group)
      recordRecent(ws.dbPath, ws.name, rows)
    } else {
      await bulkAddToWorkspace(job.target.wsId, job.target.docId, selected, group)
    }
  }

  // Resume a workspace by re-opening its db by path on restart — no re-ingest.
  const reopeningRef = useRef<Set<string>>(new Set())
  async function reopenWorkspace(doc: WorkspaceDoc): Promise<void> {
    if (!doc.dbPath || reopeningRef.current.has(doc.id)) return
    reopeningRef.current.add(doc.id)
    try {
      const info = await window.api.csv.wsOpen(doc.wsId, doc.dbPath)
      // The DB is authoritative for the column SET; the persisted doc holds display-only state
      // (column order + hidden columns). Re-apply that per source so a reload keeps the user's view.
      const sources = info.sources.map((f) => {
        const prior = doc.sources.find((s) => s.sourceId === f.sourceId)
        if (!prior) return f
        const fByName = new Map(f.columns.map((c) => [c.name, c]))
        const valid = new Set(f.columns.map((c) => c.name))
        const seen = new Set<string>()
        const ordered = [] as typeof f.columns
        for (const pc of prior.columns) {
          const fc = fByName.get(pc.name)
          if (fc) {
            ordered.push(fc)
            seen.add(fc.name)
          }
        }
        for (const fc of f.columns) if (!seen.has(fc.name)) ordered.push(fc)
        const hiddenColumns = (prior.hiddenColumns ?? []).filter((n) => valid.has(n))
        return { ...f, columns: ordered, hiddenColumns: hiddenColumns.length ? hiddenColumns : undefined }
      })
      patchWorkspaceById(doc.id, {
        name: info.name,
        sources,
        activeSourceId: doc.activeSourceId ?? info.sources[0]?.sourceId ?? null,
        intelMode: info.intelMode,
        needsReopen: false,
        reopenFailed: false
      })
      // The DB is now open → events (constellation) can be (re)loaded. The panel reads them when it
      // sees a new refreshKey, fixing "the constellation is empty after restart until I poke it".
      setFindingsRev((r) => r + 1)
    } catch {
      patchWorkspaceById(doc.id, { reopenFailed: true })
    } finally {
      reopeningRef.current.delete(doc.id)
    }
  }

  // Auto-resume the active workspace when its db isn't open yet this session (after a restart).
  const wsNeedsReopen = active?.kind === 'workspace' && !!active.needsReopen
  const wsReopenFailed = active?.kind === 'workspace' && !!active.reopenFailed
  useEffect(() => {
    if (!home && active?.kind === 'workspace' && active.needsReopen && !active.reopenFailed) {
      void reopenWorkspace(active)
    }
  }, [home, active?.id, wsNeedsReopen, wsReopenFailed]) // eslint-disable-line react-hooks/exhaustive-deps

  function selectSource(docId: string, sourceId: number): void {
    patchWorkspaceById(docId, { activeSourceId: sourceId })
  }

  /** Reorder a source's columns (drag-to-reorder); persists via localStorage. */
  function reorderSourceColumns(docId: string, sourceId: number, from: number, to: number): void {
    if (from === to || from < 0 || to < 0) return
    setState((s) => ({
      ...s,
      docs: s.docs.map((d) => {
        if (d.id !== docId || d.kind !== 'workspace') return d
        return {
          ...d,
          sources: d.sources.map((src) => {
            if (src.sourceId !== sourceId) return src
            const cols = [...src.columns]
            const [moved] = cols.splice(from, 1)
            cols.splice(to, 0, moved)
            return { ...src, columns: cols }
          })
        }
      })
    }))
  }

  /** Append columns extracted from a JSON field (db already added them to the source in place). Mutating
   *  the live doc's columns is what makes them render immediately; openWorkspace reconstructs them from
   *  source_columns on reopen, and the persisted order/hidden sets merge-by-name (tolerate new `c<n>`). */
  function appendSourceColumns(docId: string, sourceId: number, cols: WorkspaceSource['columns']): void {
    if (cols.length === 0) return
    setState((s) => ({
      ...s,
      docs: s.docs.map((d) => {
        if (d.id !== docId || d.kind !== 'workspace') return d
        return {
          ...d,
          sources: d.sources.map((src) =>
            src.sourceId === sourceId ? { ...src, columns: [...src.columns, ...cols] } : src
          )
        }
      })
    }))
  }

  /** Persist a source's hidden-column set (display-only; survives reload via the merge on reopen). */
  function setSourceHiddenColumns(docId: string, sourceId: number, hiddenColumns: string[]): void {
    setState((s) => ({
      ...s,
      docs: s.docs.map((d) => {
        if (d.id !== docId || d.kind !== 'workspace') return d
        return {
          ...d,
          sources: d.sources.map((src) =>
            src.sourceId === sourceId ? { ...src, hiddenColumns: hiddenColumns.length ? hiddenColumns : undefined } : src
          )
        }
      })
    }))
  }

  /** Open a fresh scratch tab pre-filled with a column's values (the CSV → notepad pivot). */
  function pivotToScratch(values: string[], label: string): void {
    setHome(false)
    setState((s) => {
      const doc: ScratchDoc = { ...createDoc(label), input: values.join('\n') }
      return { docs: [...s.docs, doc], activeId: doc.id }
    })
  }

  function closeDoc(id: string): void {
    const doc = docs.find((d) => d.id === id)
    if (doc?.kind === 'workspace' && doc.wsId) window.api.csv.wsClose(doc.wsId)
    setState((s) => {
      // Closing the last tab leaves no tabs open → fall back to the Home screen.
      if (s.docs.length === 1) {
        setHome(true)
        return { docs: [], activeId: '' }
      }
      const idx = s.docs.findIndex((d) => d.id === id)
      const docs = s.docs.filter((d) => d.id !== id)
      const activeId =
        id === s.activeId ? (docs[idx] ?? docs[idx - 1] ?? docs[0]).id : s.activeId
      return { docs, activeId }
    })
  }

  function selectDoc(id: string): void {
    setHome(false)
    setState((s) => ({ ...s, activeId: id }))
  }

  function renameDoc(id: string, name: string): void {
    const doc = docs.find((d) => d.id === id)
    setState((s) => ({ ...s, docs: s.docs.map((d) => (d.id === id ? { ...d, name } : d)) }))
    // Persist a workspace rename to its db (ws_meta) so it survives reopen.
    if (doc?.kind === 'workspace') void window.api.csv.wsRename(doc.wsId, name)
  }

  /** Remove a source (imported file) from a workspace (drops its data table). */
  async function removeSource(docId: string, wsId: string, sourceId: number): Promise<void> {
    if (!window.confirm('Remove this imported file from the workspace? Its data is dropped.')) return
    await window.api.csv.wsRemoveSource(wsId, sourceId)
    setState((s) => ({
      ...s,
      docs: s.docs.map((d) => {
        if (d.id !== docId || d.kind !== 'workspace') return d
        const sources = d.sources.filter((src) => src.sourceId !== sourceId)
        const activeSourceId =
          d.activeSourceId === sourceId ? (sources[0]?.sourceId ?? null) : d.activeSourceId
        return { ...d, sources, activeSourceId }
      })
    }))
  }

  /** Rename a source's display label (persists to the workspace db + updates the open doc). */
  async function renameSourceName(docId: string, wsId: string, sourceId: number, name: string): Promise<void> {
    const trimmed = name.trim()
    if (!trimmed) return
    await window.api.csv.wsRenameSource(wsId, sourceId, trimmed)
    setState((s) => ({
      ...s,
      docs: s.docs.map((d) =>
        d.id === docId && d.kind === 'workspace'
          ? { ...d, sources: d.sources.map((src) => (src.sourceId === sourceId ? { ...src, name: trimmed } : src)) }
          : d
      )
    }))
  }

  /** Set or clear a source's grouping label (host/system/origin). Empty/whitespace clears it. */
  async function setSourceGroupLabel(docId: string, wsId: string, sourceId: number, group: string | null): Promise<void> {
    const trimmed = group && group.trim() ? group.trim() : null
    await window.api.csv.wsSetSourceGroup(wsId, sourceId, trimmed)
    setState((s) => ({
      ...s,
      docs: s.docs.map((d) =>
        d.id === docId && d.kind === 'workspace'
          ? { ...d, sources: d.sources.map((src) => (src.sourceId === sourceId ? { ...src, group: trimmed } : src)) }
          : d
      )
    }))
  }

  /** Set or clear the grouping label on several sources at once (sidebar multi-select). */
  async function setSourceGroupMany(docId: string, wsId: string, sourceIds: number[], group: string | null): Promise<void> {
    const trimmed = group && group.trim() ? group.trim() : null
    const ids = new Set(sourceIds)
    await Promise.all(sourceIds.map((sid) => window.api.csv.wsSetSourceGroup(wsId, sid, trimmed)))
    setState((s) => ({
      ...s,
      docs: s.docs.map((d) =>
        d.id === docId && d.kind === 'workspace'
          ? { ...d, sources: d.sources.map((src) => (ids.has(src.sourceId) ? { ...src, group: trimmed } : src)) }
          : d
      )
    }))
  }

  // ---- workflow operations (act on the active scratch document) ----
  function addTool(toolId: string): void {
    const tool = getById(toolId)
    if (!tool || active?.kind !== 'scratch') return
    patchScratch({
      steps: [...active.steps, { uid: newId(), toolId, options: defaultOptions(tool), enabled: true }]
    })
  }

  function removeStep(uid: string): void {
    if (active?.kind !== 'scratch') return
    patchScratch({ steps: active.steps.filter((s) => s.uid !== uid) })
  }

  function toggleStepEnabled(uid: string): void {
    if (active?.kind !== 'scratch') return
    patchScratch({
      steps: active.steps.map((s) => (s.uid === uid ? { ...s, enabled: s.enabled === false } : s))
    })
  }

  function updateOptions(uid: string, options: ToolOptions): void {
    if (active?.kind !== 'scratch') return
    patchScratch({ steps: active.steps.map((s) => (s.uid === uid ? { ...s, options } : s)) })
  }

  function moveStep(uid: string, dir: -1 | 1): void {
    if (active?.kind !== 'scratch') return
    const i = active.steps.findIndex((s) => s.uid === uid)
    const j = i + dir
    if (i < 0 || j < 0 || j >= active.steps.length) return
    const steps = [...active.steps]
    ;[steps[i], steps[j]] = [steps[j], steps[i]]
    patchScratch({ steps })
  }

  // The active-workspace context handed to the AI assistant with each turn — read live so a tab/
  // source switch is reflected. When no workspace source is active the agent's grid tools report so.
  function aiWsCtx(): AiWsCtx {
    if (!home && active?.kind === 'workspace' && active.sources.length > 0) {
      return {
        hasWorkspace: true,
        wsId: active.wsId,
        workspaceName: active.name,
        activeSourceId: active.activeSourceId,
        intelDbPath: active.intelMode === 'workspace' ? workspaceIntelPath(active.dbPath) : enrichDefault,
        sources: active.sources.map((s) => ({
          sourceId: s.sourceId,
          tabId: srcKey(active.wsId, s.sourceId),
          name: s.name,
          columns: s.columns.map((c) => ({ name: c.name, original: c.original, time: c.time })),
          rowCount: s.rowCount,
          group: s.group ?? null,
          derived: s.originalPath === TIMELINE_SOURCE_MARKER
        }))
      }
    }
    return { hasWorkspace: false, sources: [], intelDbPath: enrichDefault }
  }

  // Jump the grid to a constellation event's EXACT evidence rows in a source (by rowid, not a broad
  // keyword). Switches the active source if needed, then hands the rids to that source's viewer.
  function pivotToEvidence(sourceId: number, rids: number[]): void {
    if (!active || active.kind !== 'workspace') return
    if (active.activeSourceId !== sourceId) selectSource(active.id, sourceId)
    setPendingFocus({ wsDocId: active.id, sourceId, rids, token: ++focusTokenRef.current })
  }

  // Mirror an AI group label into a workspace doc's source (the db write already happened on approval).
  function applyGroupToDoc(wsId: string, sourceId: number, group: string | null): void {
    setState((s) => ({
      ...s,
      docs: s.docs.map((d) =>
        d.kind === 'workspace' && d.wsId === wsId ? { ...d, sources: d.sources.map((src) => (src.sourceId === sourceId ? { ...src, group } : src)) } : d
      )
    }))
  }

  // Actions relayed from a detached popout window (Constellation / Timeline / AI chat). The popout
  // carries the wsId since it isn't bound to the active tab; we resolve the doc and apply it here.
  useEffect(() => {
    const off = window.api.popout.onRelay((p) => {
      const msg = p as
        | { type: 'pivot'; wsId: string; sourceId: number; rids: number[] }
        | { type: 'pivotValue'; wsId: string; value: string; source?: string }
        | { type: 'buildTimeline'; wsId: string; header: string[]; rows: string[][] }
        | { type: 'applyGroup'; wsId: string; sourceId: number; group: string | null }
        | { type: 'refresh'; wsId: string; what: 'findings' | 'tags' | 'iocs' | 'investigation' }
      const doc = docs.find((d) => d.kind === 'workspace' && d.wsId === msg.wsId)
      if (!doc || doc.kind !== 'workspace') return
      if (msg.type === 'pivot') {
        setState((s) => ({ ...s, activeId: doc.id }))
        if (doc.activeSourceId !== msg.sourceId) selectSource(doc.id, msg.sourceId)
        setPendingFocus({ wsDocId: doc.id, sourceId: msg.sourceId, rids: msg.rids, token: ++focusTokenRef.current })
      } else if (msg.type === 'pivotValue') {
        // Keyword pivot from a popped-out chat: activate the doc, then focus the value in the named
        // source (or the doc's active source as a fallback).
        setState((s) => ({ ...s, activeId: doc.id }))
        const lc = (msg.source ?? '').toLowerCase()
        const src = msg.source ? doc.sources.find((s) => s.name.toLowerCase() === lc) ?? doc.sources.find((s) => s.name.toLowerCase().includes(lc)) : undefined
        const sourceId = src ? src.sourceId : doc.activeSourceId
        if (sourceId == null) return
        if (doc.activeSourceId !== sourceId) selectSource(doc.id, sourceId)
        setPendingFocus({ wsDocId: doc.id, sourceId, value: msg.value, token: ++focusTokenRef.current })
      } else if (msg.type === 'buildTimeline') {
        void buildTimelineSourceFor(doc.id, msg.wsId, msg.header, msg.rows)
      } else if (msg.type === 'applyGroup') {
        applyGroupToDoc(msg.wsId, msg.sourceId, msg.group)
      } else if (msg.type === 'refresh') {
        if (msg.what === 'findings') setFindingsRev((r) => r + 1)
        else if (msg.what === 'iocs') setIocRev((r) => r + 1)
        else if (msg.what === 'investigation') setInvestigationRev((r) => r + 1)
        else if (msg.what === 'tags') tagApiRef.current?.reloadTags()
      }
    })
    return off
  }, [docs])

  // A pivot from the chat. Tool cards carry the source name → jump to that source's grid and keyword-
  // filter (find_rows is a "where does X appear" search); a bare prose indicator filters the open grid.
  function pivotFromChat(value: string, source?: string): void {
    if (source && active?.kind === 'workspace') {
      const lc = source.toLowerCase()
      const src = active.sources.find((s) => s.name.toLowerCase() === lc) ?? active.sources.find((s) => s.name.toLowerCase().includes(lc))
      if (src) {
        if (active.activeSourceId !== src.sourceId) selectSource(active.id, src.sourceId)
        setPendingFocus({ wsDocId: active.id, sourceId: src.sourceId, value, token: ++focusTokenRef.current })
        return
      }
    }
    tagApiRef.current?.focusValue(value)
  }

  // Manual handoff: send catalogued IOCs to the active workspace's Intel grid (global or its own).
  function sendIocsToIntel(values: string[]): void {
    if (active?.kind !== 'workspace') return
    const target =
      active.intelMode === 'workspace' ? { dbPath: workspaceIntelPath(active.dbPath), name: `${active.name} Intel` } : { dbPath: enrichDefault, name: 'Global Intel' }
    sendToEnrichment(values, target)
  }

  // The workspace-scoped panel toggles (Constellation / Timeline / Investigation / IOCs). These live
  // in the workspace's Search bar (rendered by CsvViewer) rather than the global header, since they
  // only have anything to show for an open workspace. One node, passed to each source's search bar.
  const pillToggle = (on: boolean): string =>
    `inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-semibold transition-colors ${
      on
        ? 'border-citrus-pink/50 bg-citrus-pink/10 text-citrus-pink'
        : 'border-citrus-border text-citrus-dark hover:border-citrus-pink/40 hover:text-citrus-pink dark:border-citrus-night-border dark:text-citrus-night-text'
    }`
  // Two groups: the analyst's own tools (Find, Sightings) on the left, then a divider, then the
  // Assistant's surfaces bracketed under a ✨ label so it's clear which panels the AI produces.
  const workspacePanelButtons = (
    <>
      <button className={pillToggle(findInFilesOpen)} onClick={() => setFindInFilesOpen((v) => !v)} title="Search every file for a string">
        <Search className="w-3.5 h-3.5" />
        Find
      </button>
      <button className={pillToggle(globalSightingsOpen)} onClick={() => setGlobalSightingsOpen((v) => !v)} title="Intel-Sweep hits across all files">
        <Crosshair className="w-3.5 h-3.5" />
        Sightings
      </button>

      <span className="mx-0.5 h-4 w-px shrink-0 bg-citrus-border dark:bg-citrus-night-border" />

      <div className="inline-flex items-center gap-1 rounded-md border border-citrus-pink/25 bg-citrus-pink/5 px-1.5 py-0.5 dark:border-citrus-pink/30 dark:bg-citrus-pink/10">
        <span className="inline-flex items-center gap-1 pr-0.5 text-[10px] font-bold uppercase tracking-wide text-citrus-pink" title="Panels the AI Assistant produces">
          <Sparkles className="w-3 h-3" />
          Assistant
        </span>
        <button className={pillToggle(constellationOpen)} onClick={() => setConstellationOpen((v) => !v)} title="Case graph of findings">
          <Network className="w-3.5 h-3.5" />
          Constellation
        </button>
        <button className={pillToggle(timelineOpen)} onClick={() => setTimelineOpen((v) => !v)} title="Timeline of recorded events">
          <Clock className="w-3.5 h-3.5" />
          Timeline
        </button>
        <button className={pillToggle(investigationOpen)} onClick={() => setInvestigationOpen((v) => !v)} title="The Assistant's plan and progress">
          <ClipboardList className="w-3.5 h-3.5" />
          Investigation
        </button>
        <button className={pillToggle(iocOpen)} onClick={() => setIocOpen((v) => !v)} title="Indicators the Assistant recorded">
          <Fingerprint className="w-3.5 h-3.5" />
          IOCs
        </button>
      </div>
    </>
  )

  return (
    <div className="app flex flex-col h-full">
      <header className="flex items-center justify-between px-4 py-2.5 border-b border-citrus-border bg-citrus-card dark:border-citrus-night-border dark:bg-citrus-night-card">
        <div className="flex items-center gap-2.5 min-w-0">
          <Logo />
          <span className="text-lg font-bold tracking-tight text-citrus-dark dark:text-citrus-night-text">
            pink<span className="text-citrus-pink">lemonade</span>
          </span>
          <span
            className="self-end mb-1 text-[10px] font-mono text-citrus-muted/50 dark:text-citrus-night-muted/40"
            title="Build version"
          >
            v{__APP_VERSION__}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors ${
              active?.kind === 'enrichment' && active.dbPath === enrichDefault
                ? 'border-citrus-pink/50 bg-citrus-pink/10 text-citrus-pink'
                : 'border-citrus-border text-citrus-dark hover:bg-citrus-sand/60 dark:border-citrus-night-border dark:text-citrus-night-text dark:hover:bg-citrus-night-elev'
            }`}
            onClick={() => void openEnrichmentTab()}
            title="Global Intel"
          >
            <Radar className="w-3.5 h-3.5" />
            Global Intel
          </button>
          <button
            className={`ai-panel__toggle inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors ${
              aiOpen
                ? 'border-citrus-pink/50 bg-citrus-pink/10 text-citrus-pink'
                : 'border-citrus-border text-citrus-dark hover:bg-citrus-sand/60 dark:border-citrus-night-border dark:text-citrus-night-text dark:hover:bg-citrus-night-elev'
            }`}
            onClick={() => setAiOpen((v) => !v)}
            title="AI Assistant"
          >
            <Bot className="w-3.5 h-3.5" />
            Assistant
          </button>
          <button
            className="inline-flex items-center justify-center p-1.5 rounded-full border border-citrus-border text-citrus-muted hover:text-citrus-pink hover:bg-citrus-sand/60 transition-colors dark:border-citrus-night-border dark:text-citrus-night-muted dark:hover:bg-citrus-night-elev"
            onClick={() => setAbout(true)}
            title="About"
          >
            <Info className="w-3.5 h-3.5" />
          </button>
          <button
            className="theme-toggle inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border border-citrus-border text-citrus-dark hover:bg-citrus-sand/60 transition-colors dark:border-citrus-night-border dark:text-citrus-night-text dark:hover:bg-citrus-night-elev"
            onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
            title="Toggle light / dark"
          >
            {theme === 'dark' ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
            {theme === 'dark' ? 'Light' : 'Dark'}
          </button>
        </div>
      </header>

      <div className="flex flex-1 min-h-0">
        {/* Contextual left rail: Tool Palette for a notepad, Imported-Files sidebar for a workspace. */}
        {!home && active?.kind === 'scratch' && <ToolPalette onPick={addTool} />}
        {!home && active?.kind === 'workspace' && (
          <WorkspaceSidebar
            doc={active}
            importing={csvImport?.tabId === active.wsId}
            onSelectSource={(sid) => selectSource(active.id, sid)}
            onImport={addSourceToActive}
            onImportFolder={importFolderToActive}
            onRemoveSource={(sid) => void removeSource(active.id, active.wsId, sid)}
            onRename={(name) => renameDoc(active.id, name)}
            onRenameSource={(sid, name) => void renameSourceName(active.id, active.wsId, sid, name)}
            onSetSourceGroup={(sid, group) => void setSourceGroupLabel(active.id, active.wsId, sid, group)}
            onSetSourceGroupMany={(sids, group) => void setSourceGroupMany(active.id, active.wsId, sids, group)}
            tagSummary={tagSummary}
            onToggleTagFilter={(tag) => tagApiRef.current?.toggleTagFilter(tag)}
            onExcludeTagFilter={(tag) => tagApiRef.current?.excludeTagFilter(tag)}
            onClearTagFilter={() => tagApiRef.current?.clearTagFilter()}
            intelMode={active.intelMode}
            onSetIntelMode={(mode) => void changeWorkspaceIntelMode(active.id, active.wsId, mode)}
            onOpenIntel={() => openWorkspaceIntel(active)}
          />
        )}
        <main className="flex flex-col flex-1 min-w-0 min-h-0">
          <DocTabs
            docs={docs}
            activeId={activeId}
            home={home}
            onHome={() => setHome(true)}
            onSelect={selectDoc}
            onAdd={addDoc}
            onClose={closeDoc}
            onRename={renameDoc}
          />
          {(home || !active) && (
            <Welcome
              recent={recent}
              onOpenRecent={openRecent}
              onNewWorkspace={newWorkspace}
              onImportCsv={newWorkspaceFromCsv}
              onImportFolder={newWorkspaceFromFolder}
              onOpenWorkspace={openWorkspaceFile}
              onNewScratch={addDoc}
              onNewEnrichment={openEnrichmentTab}
              workspaceDir={workspaceDir}
              onChangeWorkspaceDir={changeWorkspaceDir}
              onRemoveRecent={dropRecent}
              onClearRecent={() => {
                setRecent([])
                saveRecent([])
              }}
            />
          )}
          {/* Every doc keeps its own mounted view (hidden when inactive) so editor/viewer state
              survives tab switches; within a workspace, each source keeps its own mounted grid. */}
          {docs.map((d) => {
            const visible = !home && active?.id === d.id
            if (d.kind === 'scratch') {
              return (
                <ScratchEditor
                  key={d.id}
                  doc={d}
                  visible={visible}
                  onInput={(v) => patchScratchById(d.id, { input: v })}
                  onRemoveStep={removeStep}
                  onMoveStep={moveStep}
                  onUpdateOptions={updateOptions}
                  onToggleStepEnabled={toggleStepEnabled}
                  onClearSteps={() => patchScratch({ steps: [] })}
                  onSendToEnrichment={sendToEnrichment}
                />
              )
            }
            if (d.kind === 'enrichment') {
              return (
                <EnrichmentView
                  key={d.id}
                  doc={d}
                  visible={visible}
                  defaultDbPath={enrichDefault}
                  onPatch={(patch) => patchEnrichmentById(d.id, patch)}
                  onOpenIntelDb={openIntelDb}
                  onNewIntelDb={newIntelDb}
                  onSweep={sweepFromIntel}
                />
              )
            }
            return (
              <div
                key={d.id}
                className="flex flex-col flex-1 min-w-0 min-h-0"
                style={{ display: visible ? 'flex' : 'none' }}
              >
                {d.needsReopen ? (
                  <CsvPlaceholder name={d.name} dbPath={d.dbPath} failed={d.reopenFailed} onReopen={() => reopenWorkspace(d)} />
                ) : d.sources.length === 0 ? (
                  <div className="flex flex-1 items-center justify-center text-sm text-citrus-muted dark:text-citrus-night-muted">
                    Import a CSV from the sidebar.
                  </div>
                ) : (
                  d.sources.map((src) => {
                    // Only the visible, active source wires up to the sidebar Tags facets.
                    const isActiveSource = visible && d.activeSourceId === src.sourceId
                    return (
                      <div
                        key={src.sourceId}
                        className="flex flex-1 min-w-0 min-h-0"
                        style={{ display: d.activeSourceId === src.sourceId ? 'flex' : 'none' }}
                      >
                        <CsvViewer
                          doc={{
                            tabId: srcKey(d.wsId, src.sourceId),
                            sourceName: src.name,
                            columns: src.columns,
                            rowCount: src.rowCount,
                            dbPath: d.dbPath
                          }}
                          onPivot={pivotToScratch}
                          searchTrailing={workspacePanelButtons}
                          onReorderColumns={(from, to) => reorderSourceColumns(d.id, src.sourceId, from, to)}
                          onColumnsExtracted={(cols) => appendSourceColumns(d.id, src.sourceId, cols)}
                          savedHidden={src.hiddenColumns}
                          onHiddenColumns={(names) => setSourceHiddenColumns(d.id, src.sourceId, names)}
                          pendingSweep={
                            pendingSweep && pendingSweep.wsDocId === d.id && pendingSweep.sourceId === src.sourceId
                              ? { values: pendingSweep.values, token: pendingSweep.token }
                              : undefined
                          }
                          onConsumePendingSweep={() => setPendingSweep(null)}
                          pendingFocus={
                            pendingFocus && pendingFocus.wsDocId === d.id && pendingFocus.sourceId === src.sourceId
                              ? { value: pendingFocus.value, rids: pendingFocus.rids, token: pendingFocus.token }
                              : undefined
                          }
                          onConsumePendingFocus={() => setPendingFocus(null)}
                          onPivotEvidence={pivotToEvidence}
                          apiRef={isActiveSource ? tagApiRef : undefined}
                          onTagSummary={isActiveSource ? setTagSummary : undefined}
                          onEventRecorded={() => setFindingsRev((r) => r + 1)}
                          onSendToEnrichment={(vals) =>
                            sendToEnrichment(
                              vals,
                              d.intelMode === 'workspace'
                                ? { dbPath: workspaceIntelPath(d.dbPath), name: `${d.name} Intel` }
                                : { dbPath: enrichDefault, name: 'Global Intel' }
                            )
                          }
                          sendIntelLabel={d.intelMode === 'workspace' ? 'Workspace Intel' : 'Global Intel'}
                          intelDbPath={d.intelMode === 'workspace' ? workspaceIntelPath(d.dbPath) : enrichDefault}
                          sweepSources={d.sources}
                          onSightingsChanged={() => setSightingsRev((r) => r + 1)}
                          onOpenSightings={() => setGlobalSightingsOpen(true)}
                          sightingRefreshKey={sightingsRev}
                        />
                      </div>
                    )
                  })
                )}
              </div>
            )
          })}
        </main>
        {/* AI assistant + constellation dock beside the content (in-flow), shrinking the view. */}
        <AiPanel
          open={aiOpen}
          onClose={() => setAiOpen(false)}
          onPopOut={() => {
            // Detach the chat into its own window: it carries a snapshot of the active workspace
            // context and continues the same (localStorage-persisted) transcript. Close the docked
            // panel so there's a single chat surface driving the run.
            void window.api.popout.open('ai', { wsCtx: aiWsCtx(), title: active?.kind === 'workspace' ? active.name : undefined })
            setAiOpen(false)
          }}
          getWsCtx={aiWsCtx}
          scopeId={!home && active?.kind === 'workspace' ? active.wsId : null}
          onTagsChanged={() => tagApiRef.current?.reloadTags()}
          onFindingsChanged={() => setFindingsRev((r) => r + 1)}
          onIocsChanged={() => setIocRev((r) => r + 1)}
          onInvestigationChanged={() => setInvestigationRev((r) => r + 1)}
          onApplyGroup={(sid, group) => {
            // The AI's set_source_group tool already persisted to the db on approval; mirror it into
            // the active workspace doc so the sidebar + next-turn list_sources reflect it live.
            if (active?.kind === 'workspace') applyGroupToDoc(active.wsId, sid, group)
          }}
          onPivot={pivotFromChat}
        />
        <ConstellationPanel
          open={constellationOpen && inWorkspace}
          onClose={() => setConstellationOpen(false)}
          wsId={!home && active?.kind === 'workspace' ? active.wsId : null}
          workspaceName={!home && active?.kind === 'workspace' ? active.name : null}
          refreshKey={findingsRev}
          iocRefreshKey={iocRev}
          sources={!home && active?.kind === 'workspace' ? active.sources : []}
          onPivot={pivotToEvidence}
          onSendToIntel={sendIocsToIntel}
        />
        <TimelinePanel
          open={timelineOpen && inWorkspace}
          onClose={() => setTimelineOpen(false)}
          wsId={!home && active?.kind === 'workspace' ? active.wsId : null}
          workspaceName={!home && active?.kind === 'workspace' ? active.name : null}
          refreshKey={findingsRev}
          sources={!home && active?.kind === 'workspace' ? active.sources : []}
          onPivot={pivotToEvidence}
          onBuildSource={(header, rows) => {
            if (active?.kind !== 'workspace') return
            void buildTimelineSourceFor(active.id, active.wsId, header, rows)
          }}
        />
        <IocPanel
          open={iocOpen && inWorkspace}
          onClose={() => setIocOpen(false)}
          wsId={!home && active?.kind === 'workspace' ? active.wsId : null}
          refreshKey={iocRev}
          onSendToIntel={sendIocsToIntel}
        />
        <InvestigationPanel
          open={investigationOpen && inWorkspace}
          onClose={() => setInvestigationOpen(false)}
          wsId={!home && active?.kind === 'workspace' ? active.wsId : null}
          refreshKey={investigationRev}
          onSaved={() => setInvestigationRev((r) => r + 1)}
        />
        <GlobalSightingsPanel
          open={globalSightingsOpen && inWorkspace}
          onClose={() => setGlobalSightingsOpen(false)}
          wsId={!home && active?.kind === 'workspace' ? active.wsId : null}
          reloadKey={sightingsRev}
          onPivot={pivotToEvidence}
          onCleared={() => setSightingsRev((r) => r + 1)}
        />
        <FindInFilesPanel
          open={findInFilesOpen && inWorkspace}
          onClose={() => setFindInFilesOpen(false)}
          wsId={!home && active?.kind === 'workspace' ? active.wsId : null}
          sources={!home && active?.kind === 'workspace' ? active.sources : []}
          onPivot={pivotToEvidence}
        />
      </div>

      {folderImport && (
        <FolderImportDialog
          folderName={folderImport.name}
          files={folderImport.files}
          existingPaths={((): Set<string> | undefined => {
            const t = folderImport.target
            if (t.kind !== 'active') return undefined
            const doc = docs.find((d) => d.id === t.docId && d.kind === 'workspace') as WorkspaceDoc | undefined
            return new Set((doc?.sources ?? []).map((s) => s.originalPath).filter((p): p is string => !!p))
          })()}
          onConfirm={(selected, group) => void runFolderImport(selected, group)}
          onCancel={() => setFolderImport(null)}
        />
      )}

      {reimport && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={() => setReimport(null)}>
          <div className="w-[24rem] max-w-[90vw] rounded-xl border border-citrus-border bg-citrus-card p-5 shadow-lg dark:border-citrus-night-border dark:bg-citrus-night-card" onClick={(e) => e.stopPropagation()}>
            <div className="text-sm font-bold text-citrus-dark dark:text-citrus-night-text">Already imported</div>
            <p className="mt-2 text-xs text-citrus-muted dark:text-citrus-night-muted">
              <span className="font-mono">{reimport.sourceName}</span> is already a source in this workspace. Import it again as a duplicate?
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                className="rounded-md border border-citrus-border px-3 py-1 text-[11px] font-bold text-citrus-dark hover:bg-citrus-sand/60 dark:border-citrus-night-border dark:text-citrus-night-text dark:hover:bg-citrus-night-elev"
                onClick={() => setReimport(null)}
              >
                Cancel
              </button>
              <button
                className="rounded-md bg-citrus-pink px-3 py-1 text-[11px] font-bold text-white hover:bg-citrus-pink-hover"
                onClick={() => {
                  const r = reimport
                  setReimport(null)
                  void doSingleImport(r.wsId, r.docId, r.path, r.sourceName)
                }}
              >
                Import again
              </button>
            </div>
          </div>
        </div>
      )}

      {sweepPicker && (
        <IntelSweepTargetDialog
          workspaces={sweepableWorkspaces()}
          indicatorCount={sweepPicker.values.length}
          onConfirm={(wsDocId, sourceId) => startSweep(wsDocId, sourceId, sweepPicker.values)}
          onCancel={() => setSweepPicker(null)}
        />
      )}

      {sweepNotice && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
          onClick={() => setSweepNotice(null)}
        >
          <div
            className="w-[24rem] max-w-[90vw] rounded-xl border border-citrus-border bg-citrus-card p-5 shadow-lg dark:border-citrus-night-border dark:bg-citrus-night-card"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-sm font-bold text-citrus-dark dark:text-citrus-night-text">Run Intel Sweep</div>
            <p className="mt-2 text-xs text-citrus-muted dark:text-citrus-night-muted">{sweepNotice}</p>
            <div className="mt-4 flex justify-end">
              <button
                className="rounded-md bg-citrus-pink px-3 py-1 text-[11px] font-bold text-white hover:bg-citrus-pink-hover"
                onClick={() => setSweepNotice(null)}
              >
                Got it
              </button>
            </div>
          </div>
        </div>
      )}

      {about && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
          onClick={() => setAbout(false)}
        >
          <div
            className="w-[30rem] max-w-[90vw] rounded-xl border border-citrus-border bg-citrus-card p-5 shadow-lg dark:border-citrus-night-border dark:bg-citrus-night-card"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2.5">
              <Logo />
              <span className="text-lg font-bold tracking-tight text-citrus-dark dark:text-citrus-night-text">
                pink<span className="text-citrus-pink">lemonade</span>
              </span>
              <span className="text-[10px] font-mono text-citrus-muted dark:text-citrus-night-muted">v{__APP_VERSION__}</span>
            </div>
            <p className="mt-2 text-xs text-citrus-muted dark:text-citrus-night-muted">
              Local investigation toolkit — parse, pivot, and triage in one space.
            </p>
            <div className="mt-4 space-y-3 text-[11px] text-citrus-muted dark:text-citrus-night-muted">
              <div>
                <div className="font-semibold text-citrus-dark dark:text-citrus-night-text">License</div>
                MIT © forynsics
              </div>
            </div>
            <div className="mt-5 text-right">
              <button
                className="px-3 py-1 rounded-md text-[11px] font-bold border border-citrus-border text-citrus-dark hover:bg-citrus-sand/60 transition-colors dark:border-citrus-night-border dark:text-citrus-night-text dark:hover:bg-citrus-night-elev"
                onClick={() => setAbout(false)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {csvImport && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25">
          <div className="flex flex-col items-center gap-3 rounded-xl border border-citrus-border bg-citrus-card px-8 py-6 shadow-lg dark:border-citrus-night-border dark:bg-citrus-night-card">
            <Loader2 className="w-6 h-6 animate-spin text-citrus-pink" />
            <div className="text-sm font-bold text-citrus-dark dark:text-citrus-night-text">
              Importing {csvImport.name}…
            </div>
            {csvImport.count != null && csvImport.count > 1 && (
              <div className="text-[11px] font-semibold text-citrus-pink">
                file {csvImport.index} of {csvImport.count}
              </div>
            )}
            {csvImport.total > 0 && (
              <div className="h-1.5 w-56 overflow-hidden rounded-full bg-citrus-sand dark:bg-citrus-night-elev">
                <div
                  className="h-full rounded-full bg-citrus-pink transition-[width] duration-150"
                  style={{ width: `${Math.min(100, Math.round((csvImport.bytes / csvImport.total) * 100))}%` }}
                />
              </div>
            )}
            <div className="text-xs font-mono text-citrus-muted dark:text-citrus-night-muted">
              {csvImport.rows.toLocaleString()} rows
              {csvImport.total > 0 &&
                ` · ${Math.min(100, Math.round((csvImport.bytes / csvImport.total) * 100))}%`}
            </div>
            <button
              className="mt-1 px-3 py-1 rounded-md text-[11px] font-bold border border-citrus-border text-citrus-muted hover:text-citrus-pink hover:border-citrus-pink/40 transition-colors dark:border-citrus-night-border dark:text-citrus-night-muted"
              onClick={() => window.api.csv.cancel(csvImport.tabId)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
