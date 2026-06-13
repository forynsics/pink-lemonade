import { useEffect, useMemo, useState } from 'react'
import { Sun, Moon } from 'lucide-react'
import { Logo } from './components/Logo'
import { ToolPalette } from './components/ToolPalette'
import { WorkflowBar } from './components/WorkflowBar'
import { Workbench } from './components/Workbench'
import { DocTabs } from './components/DocTabs'
import { getById, defaultOptions } from './tools/registry'
import { runWorkflow } from './state/workflow'
import { createDoc, loadDocs, newId, saveDocs, type DocsState, type PinkDoc } from './state/documents'
import { loadTheme, saveTheme, type Theme } from './state/theme'
import type { ToolOptions } from './tools/types'

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

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    saveTheme(theme)
  }, [theme])

  useEffect(() => {
    saveDocs({ docs, activeId })
  }, [docs, activeId])

  const active = docs.find((d) => d.id === activeId) ?? docs[0]
  const result = useMemo(() => runWorkflow(active.input, active.steps), [active])

  function patchActive(patch: Partial<PinkDoc>): void {
    setState((s) => ({
      ...s,
      docs: s.docs.map((d) => (d.id === s.activeId ? { ...d, ...patch } : d))
    }))
  }

  // ---- document operations ----
  function addDoc(): void {
    setState((s) => {
      const doc = createDoc(`Untitled ${s.docs.length + 1}`)
      return { docs: [...s.docs, doc], activeId: doc.id }
    })
  }

  function closeDoc(id: string): void {
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
    setState((s) => ({ ...s, activeId: id }))
  }

  function renameDoc(id: string, name: string): void {
    setState((s) => ({ ...s, docs: s.docs.map((d) => (d.id === id ? { ...d, name } : d)) }))
  }

  // ---- workflow operations (act on the active document) ----
  function addTool(toolId: string): void {
    const tool = getById(toolId)
    if (!tool) return
    patchActive({
      steps: [...active.steps, { uid: newId(), toolId, options: defaultOptions(tool), enabled: true }]
    })
  }

  function removeStep(uid: string): void {
    patchActive({ steps: active.steps.filter((s) => s.uid !== uid) })
  }

  function toggleStepEnabled(uid: string): void {
    patchActive({
      steps: active.steps.map((s) => (s.uid === uid ? { ...s, enabled: s.enabled === false } : s))
    })
  }

  function updateOptions(uid: string, options: ToolOptions): void {
    patchActive({ steps: active.steps.map((s) => (s.uid === uid ? { ...s, options } : s)) })
  }

  function moveStep(uid: string, dir: -1 | 1): void {
    const i = active.steps.findIndex((s) => s.uid === uid)
    const j = i + dir
    if (i < 0 || j < 0 || j >= active.steps.length) return
    const steps = [...active.steps]
    ;[steps[i], steps[j]] = [steps[j], steps[i]]
    patchActive({ steps })
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
            onSelect={selectDoc}
            onAdd={addDoc}
            onClose={closeDoc}
            onRename={renameDoc}
          />
          <WorkflowBar
            steps={active.steps}
            result={result}
            onRemove={removeStep}
            onMove={moveStep}
            onOptions={updateOptions}
            onToggleEnabled={toggleStepEnabled}
            onClear={() => patchActive({ steps: [] })}
          />
          <Workbench input={active.input} onInput={(v) => patchActive({ input: v })} result={result} />
        </main>
      </div>
    </div>
  )
}
