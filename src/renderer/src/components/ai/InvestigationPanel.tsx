import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUpCircle, ClipboardList, Lightbulb, Plus, Save, Trash2, X } from 'lucide-react'
import type { CsvInvestigation, CsvLead, CsvPlanStep } from '../../state/csvTypes'
import { usePanelWidth } from '../../state/panelWidth'

// The Investigation panel — the analyst-facing view of the AI's persistent working state: an editable
// PLAN (ordered leads with a pending/active/done status) plus a PROGRESS notes field. Both live in the
// workspace DB and are shared with the agent (update_plan / save_progress), so a timeout or restart
// resumes cleanly and the analyst can steer the plan directly. Thin shell: loads on open + refreshKey,
// edits locally, saves back through ws:investigation* IPC.


type Status = CsvPlanStep['status']
const NEXT: Record<Status, Status> = { pending: 'active', active: 'done', done: 'pending' }
/** How a lead's resolution renders. A resolved lead is kept but visibly settled — an answered lead
 *  left looking open misrepresents the agent's confidence (in either direction). */
const LEAD_UI: Record<CsvLead['status'], { label: string; cls: string; card: string }> = {
  open: { label: 'Open', cls: 'text-amber-600 dark:text-amber-400', card: 'border-dashed border-amber-400/50 bg-amber-50/40 dark:border-amber-400/30 dark:bg-amber-400/[0.06]' },
  refuted: { label: 'Refuted', cls: 'text-citrus-muted dark:text-citrus-night-muted', card: 'border-citrus-border/60 bg-transparent opacity-70 dark:border-citrus-night-border/60' },
  superseded: { label: 'Superseded', cls: 'text-citrus-muted dark:text-citrus-night-muted', card: 'border-citrus-border/60 bg-transparent opacity-70 dark:border-citrus-night-border/60' },
  promoted: { label: 'Promoted → event', cls: 'text-emerald-600 dark:text-emerald-400', card: 'border-emerald-500/30 bg-emerald-50/30 dark:border-emerald-400/25 dark:bg-emerald-400/[0.05]' }
}

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
  onSaved,
  onPivot,
  onPromoted
}: {
  open: boolean
  onClose: () => void
  wsId: string | null
  /** Bump to reload after the agent updates the plan/progress/leads. */
  refreshKey: number
  /** Called after a successful save (so a shared refresh counter can bump). */
  onSaved?: () => void
  /** Jump the grid to a lead's grounding rows. */
  onPivot?: (sourceId: number, rids: number[]) => void
  /** Called after a lead is promoted to an event (so the Constellation refreshes). */
  onPromoted?: () => void
}): JSX.Element | null {
  const [plan, setPlan] = useState<CsvPlanStep[]>([])
  const [notes, setNotes] = useState('')
  const [leads, setLeads] = useState<CsvLead[]>([])
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const [dirty, setDirty] = useState(false)
  // Persisted + viewport-relative: this panel used to reopen at a fixed width every time,
  // which is why it always needed resizing (see state/panelWidth).
  const { width, setWidth, clamp } = usePanelWidth({ key: 'pink-lemonade:panel-w:investigation', min: 360, max: 900, defaultFraction: 0.32 })
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

  // Reload on open + when the agent changes it — but never clobber unsaved local edits.
  useEffect(() => {
    if (open && !dirtyRef.current) void reload()
  }, [open, reload, refreshKey])

  // Leads reload independently of the plan's dirty state (they're not edited inline here).
  const reloadLeads = useCallback(async (): Promise<void> => {
    setLeads(wsId ? await window.api.csv.wsLeadList(wsId) : [])
  }, [wsId])
  useEffect(() => {
    if (open) void reloadLeads()
  }, [open, reloadLeads, refreshKey])

  const dismissLead = async (id: string): Promise<void> => {
    if (!wsId) return
    await window.api.csv.wsLeadDelete(wsId, id)
    await reloadLeads()
  }
  const promoteLead = async (id: string): Promise<void> => {
    if (!wsId) return
    await window.api.csv.wsLeadPromote(wsId, id)
    await reloadLeads()
    onPromoted?.() // the lead is now an event — refresh the Constellation
  }

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
    const onMove = (ev: MouseEvent): void => setWidth(clamp(startW + (startX - ev.clientX)))
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
                Your AI agent builds this plan — or add your own steps.
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

          {/* Leads (AI hypotheses — unproven, grounded in rows, kept OUT of the Constellation until promoted) */}
          <div className="border-t border-citrus-border/60 px-3 py-3 dark:border-citrus-night-border/60">
            <div className="mb-2 flex items-center gap-1.5">
              <Lightbulb className="w-3.5 h-3.5 text-amber-500" />
              <span className="text-[11px] font-bold uppercase tracking-wide text-amber-600 dark:text-amber-400">Leads · unproven</span>
              {leads.length > 0 && (
                <span className="text-[10px] text-citrus-muted dark:text-citrus-night-muted">
                  · {leads.filter((l) => l.status === 'open').length} open of {leads.length}
                </span>
              )}
            </div>
            {leads.length === 0 ? (
              <div className="rounded-md border border-dashed border-citrus-border/70 px-3 py-3 text-center text-[11px] text-citrus-muted dark:border-citrus-night-border/70 dark:text-citrus-night-muted">
                Your AI agent records hypotheses here — inferences it suspects but hasn’t confirmed. Promote one to an event once evidence proves it.
              </div>
            ) : (
              <ul className="flex flex-col gap-2">
                {leads.map((l) => (
                  <li key={l.id} className={`rounded-md border px-2.5 py-2 ${LEAD_UI[l.status].card}`}>
                    <div className="mb-0.5 flex items-center gap-1.5">
                      <span className={`text-[9px] font-bold uppercase tracking-wide ${LEAD_UI[l.status].cls}`}>{LEAD_UI[l.status].label}</span>
                    </div>
                    <div className={`text-[12px] font-semibold text-citrus-dark dark:text-citrus-night-text ${l.status === 'refuted' ? 'line-through opacity-70' : ''}`}>{l.statement}</div>
                    {l.resolution && (
                      <div className="mt-0.5 text-[11px] text-citrus-muted dark:text-citrus-night-muted">
                        <span className="font-semibold">Resolved:</span> {l.resolution}
                      </div>
                    )}
                    {l.whyUncertain && (
                      <div className="mt-0.5 text-[11px] text-citrus-muted dark:text-citrus-night-muted">
                        <span className="font-semibold">Uncertain:</span> {l.whyUncertain}
                      </div>
                    )}
                    {l.nextStep && (
                      <div className="mt-0.5 text-[11px] text-citrus-muted dark:text-citrus-night-muted">
                        <span className="font-semibold">Next:</span> {l.nextStep}
                      </div>
                    )}
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {l.grounding.map((g) => (
                        <button
                          key={g.id}
                          onClick={() => onPivot?.(g.sourceId, g.rids)}
                          title={`Jump to ${g.rids.length} row(s) in ${g.sourceName}`}
                          className="inline-flex items-center gap-1 rounded border border-citrus-border px-1.5 py-0.5 text-[10px] text-citrus-muted hover:border-citrus-pink/50 hover:text-citrus-pink dark:border-citrus-night-border dark:text-citrus-night-muted"
                        >
                          <span className="max-w-[140px] truncate">
                            {g.sourceName}: <span className="font-mono">{g.matched}</span>
                          </span>
                          <span>· {g.count}</span>
                        </button>
                      ))}
                    </div>
                    <div className={`mt-1.5 flex items-center gap-2 ${l.status === 'open' ? '' : 'hidden'}`}>
                      <button
                        onClick={() => void promoteLead(l.id)}
                        title="Promote to a proven event (its grounding becomes evidence)"
                        className="inline-flex items-center gap-1 rounded border border-emerald-500/40 px-2 py-0.5 text-[10px] font-semibold text-emerald-600 hover:bg-emerald-500/10 dark:text-emerald-400"
                      >
                        <ArrowUpCircle className="w-3 h-3" /> Promote to event
                      </button>
                      <button
                        onClick={() => void dismissLead(l.id)}
                        title="Dismiss this lead"
                        className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-semibold text-citrus-muted hover:text-red-500 dark:text-citrus-night-muted"
                      >
                        <X className="w-3 h-3" /> Dismiss
                      </button>
                    </div>
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
