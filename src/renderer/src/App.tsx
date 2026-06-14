import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { Sun, Moon, Loader2 } from 'lucide-react'
import { Logo } from './components/Logo'
import { ToolPalette } from './components/ToolPalette'
import { WorkflowBar } from './components/WorkflowBar'
import { Workbench } from './components/Workbench'
import { DocTabs } from './components/DocTabs'
import { Welcome } from './components/Welcome'
import { CsvViewer } from './components/csv/CsvViewer'
import { CsvPlaceholder } from './components/csv/CsvPlaceholder'
import { getById, defaultOptions } from './tools/registry'
import { runWorkflow, type WorkflowStep } from './state/workflow'
import {
  createDoc,
  createCsvDoc,
  loadDocs,
  newId,
  saveDocs,
  type CsvDoc,
  type DocsState,
  type PinkDoc,
  type ScratchDoc
} from './state/documents'
import { loadTheme, saveTheme, type Theme } from './state/theme'
import { addRecent, loadRecent, removeRecent, saveRecent, type RecentFile } from './state/recent'
import type { ToolOptions } from './tools/types'

const NO_STEPS: WorkflowStep[] = []

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
  const [csvImport, setCsvImport] = useState<{ tabId: string; name: string; rows: number } | null>(null)
  // Recently-opened CSV files (welcome-screen quick pivot) + whether the welcome screen is showing.
  const [recent, setRecent] = useState<RecentFile[]>(loadRecent)
  // The app opens on the Home/welcome screen by default (the user's saved tabs stay in the
  // tab bar; clicking one — or any open/new action — leaves Home).
  const [home, setHome] = useState<boolean>(true)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    saveTheme(theme)
  }, [theme])

  // Live ingest progress for the active import.
  useEffect(() => {
    return window.api.csv.onProgress((p) => {
      setCsvImport((cur) => (cur && p.tabId === cur.tabId && p.phase !== 'done' ? { ...cur, rows: p.rows } : cur))
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
  // Workflow runs only for scratch docs. Hooks must run unconditionally, so derive scratch
  // input/steps (falling back to empties for a CSV doc) and run the workflow on a deferred
  // copy of the input so the textarea stays responsive while a heavy pipeline catches up.
  const scratchInput = active.kind === 'scratch' ? active.input : ''
  const scratchSteps = active.kind === 'scratch' ? active.steps : NO_STEPS
  const deferredInput = useDeferredValue(scratchInput)
  const result = useMemo(
    () => runWorkflow(deferredInput, scratchSteps),
    [deferredInput, scratchSteps]
  )

  function updateActive(fn: (d: PinkDoc) => PinkDoc): void {
    setState((s) => ({ ...s, docs: s.docs.map((d) => (d.id === s.activeId ? fn(d) : d)) }))
  }

  function patchScratch(patch: Partial<ScratchDoc>): void {
    updateActive((d) => (d.kind === 'scratch' ? { ...d, ...patch } : d))
  }

  function patchCsv(patch: Partial<CsvDoc>): void {
    updateActive((d) => (d.kind === 'csv' ? { ...d, ...patch } : d))
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

  /** Ingest a file at `path` into a fresh CSV tab. Shared by the picker and recent-file pivots. */
  async function ingestNewTab(path: string, sourceName: string): Promise<void> {
    const tabId = newId()
    setCsvImport({ tabId, name: sourceName, rows: 0 })
    try {
      const res = await window.api.csv.ingest(tabId, path)
      if (res) {
        setHome(false)
        setState((s) => {
          const doc = createCsvDoc(res)
          return { docs: [...s.docs, doc], activeId: doc.id }
        })
        recordRecent(path, res.sourceName, res.rowCount)
      }
    } catch {
      // File missing/unreadable (common for a stale recent entry) — drop it from the list.
      dropRecent(path)
    } finally {
      setCsvImport(null)
    }
  }

  async function openCsv(): Promise<void> {
    const picked = await window.api.csv.pick()
    if (picked) await ingestNewTab(picked.path, picked.sourceName)
  }

  function openRecent(f: RecentFile): void {
    void ingestNewTab(f.path, f.sourceName)
  }

  async function reopenCsv(): Promise<void> {
    const picked = await window.api.csv.pick()
    if (!picked) return
    const tabId = newId()
    setCsvImport({ tabId, name: picked.sourceName, rows: 0 })
    try {
      const res = await window.api.csv.ingest(tabId, picked.path)
      if (res) {
        patchCsv({
          tabId: res.tabId,
          columns: res.columns,
          rowCount: res.rowCount,
          dbPath: res.dbPath,
          sourceName: res.sourceName,
          needsReopen: false
        })
        recordRecent(picked.path, res.sourceName, res.rowCount)
      }
    } finally {
      setCsvImport(null)
    }
  }

  /** Reorder the active CSV's columns (drag-to-reorder); persists via patchCsv → localStorage. */
  function reorderCsvColumns(from: number, to: number): void {
    if (active.kind !== 'csv' || from === to || from < 0 || to < 0) return
    const cols = [...active.columns]
    const [moved] = cols.splice(from, 1)
    cols.splice(to, 0, moved)
    patchCsv({ columns: cols })
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
    if (doc?.kind === 'csv' && doc.tabId) window.api.csv.close(doc.tabId)
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
    setState((s) => ({ ...s, docs: s.docs.map((d) => (d.id === id ? { ...d, name } : d)) }))
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
        <ToolPalette onPick={addTool} />
        <main className="flex flex-col flex-1 min-w-0 min-h-0">
          <DocTabs
            docs={docs}
            activeId={activeId}
            home={home}
            onHome={() => setHome(true)}
            onSelect={selectDoc}
            onAdd={addDoc}
            onAddCsv={openCsv}
            onClose={closeDoc}
            onRename={renameDoc}
          />
          {home ? (
            <Welcome
              recent={recent}
              onOpenRecent={openRecent}
              onOpenCsv={openCsv}
              onNewScratch={addDoc}
              onRemoveRecent={dropRecent}
              onClearRecent={() => {
                setRecent([])
                saveRecent([])
              }}
            />
          ) : active.kind === 'csv' ? (
            active.needsReopen ? (
              <CsvPlaceholder doc={active} onReopen={reopenCsv} />
            ) : (
              <CsvViewer doc={active} onPivot={pivotToScratch} onReorderColumns={reorderCsvColumns} />
            )
          ) : (
            <>
              <WorkflowBar
                steps={active.steps}
                result={result}
                onRemove={removeStep}
                onMove={moveStep}
                onOptions={updateOptions}
                onToggleEnabled={toggleStepEnabled}
                onClear={() => patchScratch({ steps: [] })}
              />
              <Workbench
                input={active.input}
                onInput={(v) => patchScratch({ input: v })}
                result={result}
              />
            </>
          )}
        </main>
      </div>

      {csvImport && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3 rounded-xl border border-citrus-border bg-citrus-card px-8 py-6 shadow-lg dark:border-citrus-night-border dark:bg-citrus-night-card">
            <Loader2 className="w-6 h-6 animate-spin text-citrus-pink" />
            <div className="text-sm font-bold text-citrus-dark dark:text-citrus-night-text">
              Importing {csvImport.name}…
            </div>
            <div className="text-xs font-mono text-citrus-muted dark:text-citrus-night-muted">
              {csvImport.rows.toLocaleString()} rows
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
