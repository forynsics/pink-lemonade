import { useEffect, useRef, useState } from 'react'
import { Sun, Moon, Loader2 } from 'lucide-react'
import { Logo } from './components/Logo'
import { ToolPalette } from './components/ToolPalette'
import { ScratchEditor } from './components/ScratchEditor'
import { DocTabs } from './components/DocTabs'
import { Welcome } from './components/Welcome'
import { CsvViewer, type CsvViewerHandle, type TagSummary } from './components/csv/CsvViewer'
import { CsvPlaceholder } from './components/csv/CsvPlaceholder'
import { WorkspaceSidebar } from './components/csv/WorkspaceSidebar'
import { getById, defaultOptions } from './tools/registry'
import {
  createDoc,
  createWorkspaceDoc,
  loadDocs,
  newId,
  saveDocs,
  type DocsState,
  type PinkDoc,
  type ScratchDoc,
  type WorkspaceDoc,
  type WorkspaceSource
} from './state/documents'
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
  const first = createDoc('Untitled 1')
  return { docs: [first], activeId: first.id }
}

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
  } | null>(null)
  // Recently-opened CSV files (welcome-screen quick pivot) + whether the welcome screen is showing.
  const [recent, setRecent] = useState<RecentFile[]>(loadRecent)
  // The app opens on the Home/welcome screen by default (the user's saved tabs stay in the
  // tab bar; clicking one — or any open/new action — leaves Home).
  const [home, setHome] = useState<boolean>(true)
  // Tag rollup of the active workspace source (for the sidebar Tags facets) + a handle to drive its
  // tag filter. Only the active source's viewer populates these.
  const [tagSummary, setTagSummary] = useState<TagSummary | null>(null)
  const tagApiRef = useRef<CsvViewerHandle | null>(null)

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

  const active = docs.find((d) => d.id === activeId) ?? docs[0]

  // Clear the sidebar tag rollup when the active source changes; the newly-active viewer re-reports.
  const activeSrcKey = active.kind === 'workspace' ? `${active.id}:${active.activeSourceId}` : active.id
  useEffect(() => {
    setTagSummary(null)
  }, [activeSrcKey])

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
    let src: WorkspaceSource | null = null
    try {
      src = await window.api.csv.wsAddSource(wsId, picked.path)
    } finally {
      setCsvImport(null)
    }
    const doc = createWorkspaceDoc({ ...ws, sources: src ? [src] : [] })
    setState((s) => ({ docs: [...s.docs, doc], activeId: doc.id }))
    recordRecent(ws.dbPath, ws.name, src?.rowCount ?? 0)
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

  /** Open an existing workspace db by path (activating it if already open). */
  async function openWorkspaceByPath(dbPath: string): Promise<void> {
    const existing = docs.find((d) => d.kind === 'workspace' && d.dbPath === dbPath && !d.needsReopen)
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

  function openRecent(f: RecentFile): void {
    void openWorkspaceByPath(f.path)
  }

  /** Add a CSV as a new source to the active workspace (sidebar "Import"). */
  async function addSourceToActive(): Promise<void> {
    if (active.kind !== 'workspace') return
    const picked = await window.api.csv.pick()
    if (!picked) return
    const { wsId, id: docId } = active
    setCsvImport({ tabId: wsId, name: picked.sourceName, rows: 0, bytes: 0, total: 0 })
    let src: WorkspaceSource | null = null
    try {
      src = await window.api.csv.wsAddSource(wsId, picked.path)
    } finally {
      setCsvImport(null)
    }
    if (src) {
      const added = src
      setState((s) => ({
        ...s,
        docs: s.docs.map((d) =>
          d.id === docId && d.kind === 'workspace'
            ? { ...d, sources: [...d.sources, added], activeSourceId: added.sourceId }
            : d
        )
      }))
    }
  }

  // Resume a workspace by re-opening its db by path on restart — no re-ingest.
  const reopeningRef = useRef<Set<string>>(new Set())
  async function reopenWorkspace(doc: WorkspaceDoc): Promise<void> {
    if (!doc.dbPath || reopeningRef.current.has(doc.id)) return
    reopeningRef.current.add(doc.id)
    try {
      const info = await window.api.csv.wsOpen(doc.wsId, doc.dbPath)
      patchWorkspaceById(doc.id, {
        name: info.name,
        sources: info.sources,
        activeSourceId: doc.activeSourceId ?? info.sources[0]?.sourceId ?? null,
        needsReopen: false,
        reopenFailed: false
      })
    } catch {
      patchWorkspaceById(doc.id, { reopenFailed: true })
    } finally {
      reopeningRef.current.delete(doc.id)
    }
  }

  // Auto-resume the active workspace when its db isn't open yet this session (after a restart).
  const wsNeedsReopen = active.kind === 'workspace' && !!active.needsReopen
  const wsReopenFailed = active.kind === 'workspace' && !!active.reopenFailed
  useEffect(() => {
    if (!home && active.kind === 'workspace' && active.needsReopen && !active.reopenFailed) {
      void reopenWorkspace(active)
    }
  }, [home, active.id, wsNeedsReopen, wsReopenFailed]) // eslint-disable-line react-hooks/exhaustive-deps

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
      if (s.docs.length === 1) {
        const fresh = createDoc('Untitled 1')
        return { docs: [fresh], activeId: fresh.id }
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

  // ---- workflow operations (act on the active scratch document) ----
  function addTool(toolId: string): void {
    const tool = getById(toolId)
    if (!tool || active.kind !== 'scratch') return
    patchScratch({
      steps: [...active.steps, { uid: newId(), toolId, options: defaultOptions(tool), enabled: true }]
    })
  }

  function removeStep(uid: string): void {
    if (active.kind !== 'scratch') return
    patchScratch({ steps: active.steps.filter((s) => s.uid !== uid) })
  }

  function toggleStepEnabled(uid: string): void {
    if (active.kind !== 'scratch') return
    patchScratch({
      steps: active.steps.map((s) => (s.uid === uid ? { ...s, enabled: s.enabled === false } : s))
    })
  }

  function updateOptions(uid: string, options: ToolOptions): void {
    if (active.kind !== 'scratch') return
    patchScratch({ steps: active.steps.map((s) => (s.uid === uid ? { ...s, options } : s)) })
  }

  function moveStep(uid: string, dir: -1 | 1): void {
    if (active.kind !== 'scratch') return
    const i = active.steps.findIndex((s) => s.uid === uid)
    const j = i + dir
    if (i < 0 || j < 0 || j >= active.steps.length) return
    const steps = [...active.steps]
    ;[steps[i], steps[j]] = [steps[j], steps[i]]
    patchScratch({ steps })
  }

  return (
    <div className="app flex flex-col h-full">
      <header className="flex items-center justify-between px-4 py-2.5 border-b border-citrus-border bg-citrus-card dark:border-citrus-night-border dark:bg-citrus-night-card">
        <div className="flex items-center gap-2.5">
          <Logo />
          <span className="text-lg font-bold tracking-tight text-citrus-dark dark:text-citrus-night-text">
            pink<span className="text-citrus-pink">lemonade</span>
          </span>
          <span className="text-[11px] font-mono text-citrus-muted dark:text-citrus-night-muted">
            local investigation toolkit
          </span>
        </div>
        <button
          className="theme-toggle inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border border-citrus-border text-citrus-dark hover:bg-citrus-sand/60 transition-colors dark:border-citrus-night-border dark:text-citrus-night-text dark:hover:bg-citrus-night-elev"
          onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
          title="Toggle light / dark"
        >
          {theme === 'dark' ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
          {theme === 'dark' ? 'Light' : 'Dark'}
        </button>
      </header>

      <div className="flex flex-1 min-h-0">
        {/* Contextual left rail: Tool Palette for a notepad, Imported-Files sidebar for a workspace. */}
        {!home && active.kind === 'scratch' && <ToolPalette onPick={addTool} />}
        {!home && active.kind === 'workspace' && (
          <WorkspaceSidebar
            doc={active}
            importing={csvImport?.tabId === active.wsId}
            onSelectSource={(sid) => selectSource(active.id, sid)}
            onImport={addSourceToActive}
            onRemoveSource={(sid) => void removeSource(active.id, active.wsId, sid)}
            tagSummary={tagSummary}
            onToggleTagFilter={(tag) => tagApiRef.current?.toggleTagFilter(tag)}
            onClearTagFilter={() => tagApiRef.current?.clearTagFilter()}
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
            onAddCsv={newWorkspaceFromCsv}
            onClose={closeDoc}
            onRename={renameDoc}
          />
          {home && (
            <Welcome
              recent={recent}
              onOpenRecent={openRecent}
              onNewWorkspace={newWorkspace}
              onImportCsv={newWorkspaceFromCsv}
              onOpenWorkspace={openWorkspaceFile}
              onNewScratch={addDoc}
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
            const visible = !home && active.id === d.id
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
                />
              )
            }
            return (
              <div
                key={d.id}
                className="flex flex-col flex-1 min-h-0"
                style={{ display: visible ? 'flex' : 'none' }}
              >
                {d.needsReopen ? (
                  <CsvPlaceholder name={d.name} dbPath={d.dbPath} failed={d.reopenFailed} onReopen={() => reopenWorkspace(d)} />
                ) : d.sources.length === 0 ? (
                  <div className="flex flex-1 items-center justify-center text-sm text-citrus-muted dark:text-citrus-night-muted">
                    Empty workspace — import a CSV from the sidebar.
                  </div>
                ) : (
                  d.sources.map((src) => {
                    // Only the visible, active source wires up to the sidebar Tags facets.
                    const isActiveSource = visible && d.activeSourceId === src.sourceId
                    return (
                      <div
                        key={src.sourceId}
                        className="flex flex-1 min-h-0"
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
                          onReorderColumns={(from, to) => reorderSourceColumns(d.id, src.sourceId, from, to)}
                          apiRef={isActiveSource ? tagApiRef : undefined}
                          onTagSummary={isActiveSource ? setTagSummary : undefined}
                        />
                      </div>
                    )
                  })
                )}
              </div>
            )
          })}
        </main>
      </div>

      {csvImport && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3 rounded-xl border border-citrus-border bg-citrus-card px-8 py-6 shadow-lg dark:border-citrus-night-border dark:bg-citrus-night-card">
            <Loader2 className="w-6 h-6 animate-spin text-citrus-pink" />
            <div className="text-sm font-bold text-citrus-dark dark:text-citrus-night-text">
              Importing {csvImport.name}…
            </div>
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
