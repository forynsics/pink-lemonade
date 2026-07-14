import { useCallback, useEffect, useRef, useState } from 'react'
import { ClipboardList, Plus, Save, Trash2, X } from 'lucide-react'
import type { CsvInvestigation, CsvPlanStep } from '../../state/csvTypes'

// The Investigation panel — the analyst-facing view of the AI's persistent working state: an editable
// PLAN (ordered leads with a pending/active/done status) plus a PROGRESS notes field. Both live in the
// workspace DB and are shared with the agent (update_plan / save_progress), so a timeout or restart
// resumes cleanly and the analyst can steer the plan directly. Thin shell: loads on open + refreshKey,
// edits locally, saves back through ws:investigation* IPC.

const MIN_W = 360
const MAX_W = 900

type Status = CsvPlanStep['status']
const NEXT: Record<Status, Status> = { pending: 'active', active: 'done', done: 'pending' }
const STATUS_UI: Record<Status, { label: string; cls: string }> = {
  pending: { label: '○ To do', cls: 'text-citrus-muted dark:text-citrus-night-muted' },
  active: { label: '◐ Active', cls: 'text-citrus-pink' },
  done: { label: '✓ Done', cls: 'text-emerald-600 dark:text-emerald-400 line-through/none' }
}

export function InvestigationPanel({
  open,
  onClose,
  wsId,
  refreshKey,
  onSaved
}: {
  open: boolean
  onClose: () => void
  wsId: string | null
  /** Bump to reload after the assistant updates the plan/progress. */
  refreshKey: number
  /** Called after a successful save (so a shared refresh counter can bump). */
  onSaved?: () => void
}): JSX.Element | null {
  const [plan, setPlan] = useState<CsvPlanStep[]>([])
  const [notes, setNotes] = useState('')
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const [dirty, setDirty] = useState(false)
  const [width, setWidth] = useState(440)
  const dirtyRef = useRef(false)
  dirtyRef.current = dirty

  const reload = useCallback(async (): Promise<void> => {
    if (!wsId) {
      setPlan([])
      setNotes('')
      setUpdatedAt(null)
      setDirty(false)
      return
    }
    const inv = (await window.api.csv.wsInvestigationGet(wsId)) as CsvInvestigation
    setPlan(inv.plan ?? [])
    setNotes(inv.notes ?? '')
    setUpdatedAt(inv.updatedAt ?? null)
    setDirty(false)
  }, [wsId])

  // Reload on open + when the assistant changes it — but never clobber unsaved local edits.
  useEffect(() => {
    if (open && !dirtyRef.current) void reload()
  }, [open, reload, refreshKey])

  const markDirty = (): void => setDirty(true)
  const setStep = (i: number, patch: Partial<CsvPlanStep>): void => {
    setPlan((p) => p.map((s, j) => (j === i ? { ...s, ...patch } : s)))
    markDirty()
  }
  const addStep = (): void => {
    setPlan((p) => [...p, { text: '', status: 'pending' }])
    markDirty()
  }
  const removeStep = (i: number): void => {
    setPlan((p) => p.filter((_, j) => j !== i))
    markDirty()
  }

  async function save(): Promise<void> {
    if (!wsId) return
    const clean = plan.map((s) => ({ text: s.text.trim(), status: s.status })).filter((s) => s.text)
    await window.api.csv.wsInvestigationSetPlan(wsId, clean)
    await window.api.csv.wsInvestigationSetNotes(wsId, notes)
    setDirty(false)
    onSaved?.()
    void reload()
  }

  const startResize = (e: React.MouseEvent): void => {
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    const onMove = (ev: MouseEvent): void => setWidth(Math.min(MAX_W, Math.max(MIN_W, startW + (startX - ev.clientX))))
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  if (!open) return null

  const doneCount = plan.filter((s) => s.status === 'done').length

  return (
    <aside
      className="investigation-panel relative flex min-h-0 shrink-0 flex-col border-l border-citrus-border bg-citrus-card dark:border-citrus-night-border dark:bg-citrus-night-card"
      style={{ width }}
    >
      <div className="absolute left-0 top-0 z-10 h-full w-1 cursor-col-resize hover:bg-citrus-pink/40" onMouseDown={startResize} title="Drag to resize" />

      <div className="flex items-center justify-between gap-2 border-b border-citrus-border px-4 py-3 dark:border-citrus-night-border">
        <div className="flex items-center gap-2 min-w-0">
          <ClipboardList className="w-4 h-4 text-citrus-pink shrink-0" />
          <div className="min-w-0">
            <div className="text-sm font-bold text-citrus-dark dark:text-citrus-night-text">Investigation</div>
            <div className="text-[11px] text-citrus-muted dark:text-citrus-night-muted">
              {plan.length === 0 ? 'No plan yet' : `${doneCount}/${plan.length} done`}
              {updatedAt ? ` · updated ${new Date(updatedAt).toLocaleString()}` : ''}
              {dirty ? ' · unsaved' : ''}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => void save()}
            disabled={!dirty || !wsId}
            title="Save plan + notes"
            className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-semibold text-citrus-muted enabled:hover:text-citrus-pink disabled:opacity-40 dark:text-citrus-night-muted"
          >
            <Save className="w-3.5 h-3.5" /> Save
          </button>
          <button onClick={onClose} title="Close" className="rounded p-1 text-citrus-muted hover:text-citrus-pink dark:text-citrus-night-muted">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {!wsId ? (
        <div className="px-4 py-8 text-center text-[12px] text-citrus-muted dark:text-citrus-night-muted">Open a workspace to track a plan.</div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-auto">
          {/* Plan */}
          <div className="px-3 py-3">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-[11px] font-bold uppercase tracking-wide text-citrus-muted dark:text-citrus-night-muted">Plan</div>
              <button onClick={addStep} title="Add a step" className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-citrus-muted hover:text-citrus-pink dark:text-citrus-night-muted">
                <Plus className="w-3.5 h-3.5" /> Step
              </button>
            </div>
            {plan.length === 0 ? (
              <div className="rounded-md border border-dashed border-citrus-border/70 px-3 py-4 text-center text-[12px] text-citrus-muted dark:border-citrus-night-border/70 dark:text-citrus-night-muted">
                The Assistant builds this plan — or add your own steps.
              </div>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {plan.map((s, i) => (
                  <li key={i} className="flex items-start gap-1.5">
                    <button
                      onClick={() => setStep(i, { status: NEXT[s.status] })}
                      title="Click to cycle: To do → Active → Done"
                      className={`mt-1 shrink-0 whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-semibold ${STATUS_UI[s.status].cls}`}
                    >
                      {STATUS_UI[s.status].label}
                    </button>
                    <textarea
                      value={s.text}
                      onChange={(e) => setStep(i, { text: e.target.value })}
                      rows={1}
                      placeholder="Lead / next action…"
                      className={`min-h-[28px] flex-1 resize-y rounded border border-citrus-border bg-citrus-bg px-2 py-1 text-[12px] text-citrus-dark outline-none focus:border-citrus-pink/60 dark:border-citrus-night-border dark:bg-citrus-night-bg dark:text-citrus-night-text ${
                        s.status === 'done' ? 'line-through opacity-60' : ''
                      }`}
                    />
                    <button onClick={() => removeStep(i)} title="Remove step" className="mt-1 shrink-0 rounded p-1 text-citrus-muted hover:text-red-500 dark:text-citrus-night-muted">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Progress notes */}
          <div className="border-t border-citrus-border/60 px-3 py-3 dark:border-citrus-night-border/60">
            <div className="mb-2 text-[11px] font-bold uppercase tracking-wide text-citrus-muted dark:text-citrus-night-muted">Progress notes</div>
            <textarea
              value={notes}
              onChange={(e) => {
                setNotes(e.target.value)
                markDirty()
              }}
              rows={6}
              placeholder="Current lead, hypothesis, next step…"
              className="w-full resize-y rounded border border-citrus-border bg-citrus-bg px-2 py-1.5 text-[12px] leading-relaxed text-citrus-dark outline-none focus:border-citrus-pink/60 dark:border-citrus-night-border dark:bg-citrus-night-bg dark:text-citrus-night-text"
            />
          </div>
        </div>
      )}
    </aside>
  )
}
