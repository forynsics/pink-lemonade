import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Bot, Check, ChevronDown, ChevronRight, RotateCcw, Telescope, UserRound, X } from 'lucide-react'
import type { CsvCaseReportItem } from '../../state/csvTypes'

// The Case Report's guts, shared verbatim by the side panel and the pop-out window — the panel is
// cramped for adjudicating dozens of claims with reasons, so both mount THIS and the pop-out just
// gives it the whole window.
//
// It is a review QUEUE, not a graph: every claim the case contains (events, leads, proven absences,
// evidence gaps, entity verdicts) in one place the analyst agrees or disagrees with. Pending first,
// grouped by host, because "what still needs me, on which machine" is the question you open it to ask.

const KIND_LABEL: Record<CsvCaseReportItem['kind'], string> = {
  event: 'Event',
  lead: 'Lead',
  negative: 'Negative',
  entity: 'Entity'
}

// Flags that mean "look here first" get colour; the rest are quiet metadata.
const LOUD_FLAGS = new Set(['overturned', 'unsettled', 'stale', 'single-source', 'not-collected'])

function flagClass(flag: string): string {
  return LOUD_FLAGS.has(flag)
    ? 'border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-400'
    : 'border-citrus-border text-citrus-muted dark:border-citrus-night-border dark:text-citrus-night-muted'
}

interface Group {
  host: string
  items: CsvCaseReportItem[]
}

export function CaseReportBody({
  wsId,
  refreshKey,
  onOpen
}: {
  wsId: string | null
  refreshKey: number
  /** Jump to a claim's home so its citations are visible — an event to the Constellation, a lead to
   *  the Investigation panel, an entity to Systems & Accounts. Absent in the pop-out unless relayed. */
  onOpen?: (item: CsvCaseReportItem) => void
}): JSX.Element {
  const [items, setItems] = useState<CsvCaseReportItem[]>([])
  const [showResolved, setShowResolved] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  // Which item is mid-rejection, and the reason being typed. A rejection without a reason is refused
  // by the store, so the UI makes the reason the actual gate rather than discovering it on submit.
  const [rejecting, setRejecting] = useState<string | null>(null)
  const [reasonDraft, setReasonDraft] = useState('')

  const reload = useCallback(async (): Promise<void> => {
    if (!wsId) {
      setItems([])
      return
    }
    try {
      setItems(await window.api.csv.wsCaseReport(wsId))
    } catch {
      /* workspace may have closed in the main window — keep what we have */
    }
  }, [wsId])

  useEffect(() => {
    void reload()
  }, [reload, refreshKey])

  const pending = useMemo(() => items.filter((i) => i.verdict === 'pending'), [items])
  const resolved = useMemo(() => items.filter((i) => i.verdict !== 'pending'), [items])

  // Group the visible set by host. Claims with no host (leads, accounts) fall under one bucket so
  // they are never lost, and it sorts last.
  const groups = useMemo<Group[]>(() => {
    const visible = showResolved ? items : pending
    const by = new Map<string, CsvCaseReportItem[]>()
    for (const it of visible) {
      const host = it.hosts[0] ?? '—'
      const arr = by.get(host) ?? []
      arr.push(it)
      by.set(host, arr)
    }
    return [...by.entries()]
      .map(([host, list]) => ({ host, items: list }))
      .sort((a, b) => (a.host === '—' ? 1 : b.host === '—' ? -1 : a.host.localeCompare(b.host)))
  }, [items, pending, showResolved])

  async function setVerdict(it: CsvCaseReportItem, verdict: string, reason: string | null): Promise<void> {
    if (!wsId) return
    const res = await window.api.csv.wsCaseReview(wsId, it.kind, it.id, verdict, reason)
    if (res && res.ok === false) return // store refused (e.g. reject without reason) — leave the editor open
    setRejecting(null)
    setReasonDraft('')
    await reload()
  }

  function toggleGroup(host: string): void {
    setCollapsed((prev) => {
      const next = new Set(prev)
      next.has(host) ? next.delete(host) : next.add(host)
      return next
    })
  }

  async function approveGroup(g: Group): Promise<void> {
    for (const it of g.items.filter((i) => i.verdict === 'pending')) await setVerdict(it, 'approved', null)
  }

  if (!wsId) {
    return <div className="px-4 py-6 text-center text-[12px] text-citrus-muted dark:text-citrus-night-muted">Open a case to review its findings.</div>
  }

  const row = (it: CsvCaseReportItem): JSX.Element => (
    <div
      key={`${it.kind}:${it.id}`}
      className={`rounded-md px-2 py-1.5 text-[12px] ${
        it.verdict === 'rejected' ? 'opacity-70' : ''
      } hover:bg-citrus-sand/50 dark:hover:bg-citrus-night-elev`}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1">
            <span className="rounded border border-citrus-border px-1 text-[9px] font-bold uppercase text-citrus-muted dark:border-citrus-night-border dark:text-citrus-night-muted">
              {KIND_LABEL[it.kind]}
            </span>
            <span
              className={`inline-flex items-center gap-0.5 rounded border px-1 text-[9px] font-bold uppercase ${
                it.actor === 'ai'
                  ? 'border-citrus-border text-citrus-muted dark:border-citrus-night-border dark:text-citrus-night-muted'
                  : 'border-emerald-500/50 text-emerald-600 dark:text-emerald-400'
              }`}
              title={it.actor === 'ai' ? 'Recorded by your AI agent' : 'Recorded by you'}
            >
              {it.actor === 'ai' ? <Bot className="h-2.5 w-2.5" /> : <UserRound className="h-2.5 w-2.5" />}
              {it.actor === 'ai' ? 'AI' : 'Analyst'}
            </span>
            <span
              className={`truncate font-semibold ${
                it.verdict === 'rejected' ? 'text-citrus-muted line-through dark:text-citrus-night-muted' : 'text-citrus-dark dark:text-citrus-night-text'
              }`}
              title={it.title}
            >
              {it.title}
            </span>
          </div>
          {it.detail && <div className="mt-0.5 text-[10px] leading-snug text-citrus-muted dark:text-citrus-night-muted">{it.detail}</div>}
          {it.flags.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {it.flags.map((f) => (
                <span key={f} className={`rounded border px-1 text-[9px] font-semibold uppercase ${flagClass(f)}`}>
                  {f}
                </span>
              ))}
            </div>
          )}
          {/* The rejection reason is the whole point of keeping a rejected claim — always shown. */}
          {it.verdict === 'rejected' && it.reason && (
            <div className="mt-1 rounded border border-red-500/30 bg-red-500/5 px-1.5 py-1 text-[10px] leading-snug text-red-700 dark:text-red-400">
              <span className="font-bold uppercase">Rejected — </span>
              {it.reason}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {onOpen && it.kind !== 'negative' && (
            <button
              onClick={() => onOpen(it)}
              title={
                it.kind === 'event' ? 'Open in the Constellation to see its evidence'
                  : it.kind === 'lead' ? 'Open in the Investigation panel'
                  : 'Open in Systems & Accounts'
              }
              className="rounded p-0.5 text-citrus-muted hover:text-citrus-pink dark:text-citrus-night-muted"
            >
              <Telescope className="h-3.5 w-3.5" />
            </button>
          )}
          {it.verdict === 'pending' ? (
            <>
              <button
                onClick={() => void setVerdict(it, 'approved', null)}
                title="Approve"
                className="rounded border border-emerald-500/50 p-0.5 text-emerald-600 hover:bg-emerald-500/10 dark:text-emerald-400"
              >
                <Check className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={() => {
                  setRejecting(`${it.kind}:${it.id}`)
                  setReasonDraft('')
                }}
                title="Reject (needs a reason)"
                className="rounded border border-red-500/50 p-0.5 text-red-600 hover:bg-red-500/10 dark:text-red-400"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </>
          ) : (
            <button
              onClick={() => void setVerdict(it, 'pending', null)}
              title="Undo — back to pending"
              className="rounded p-0.5 text-citrus-muted hover:text-citrus-pink dark:text-citrus-night-muted"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {rejecting === `${it.kind}:${it.id}` && (
        <div className="mt-1.5 rounded border border-red-500/40 bg-red-500/5 px-2 py-1.5">
          <div className="mb-1 text-[10px] font-semibold text-citrus-dark dark:text-citrus-night-text">
            Why is this wrong? Your reasoning is kept and shown to the agent.
          </div>
          <textarea
            autoFocus
            value={reasonDraft}
            onChange={(e) => setReasonDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && reasonDraft.trim()) void setVerdict(it, 'rejected', reasonDraft.trim())
              if (e.key === 'Escape') setRejecting(null)
            }}
            placeholder="e.g. This is the IR team's own tooling, not the attacker's — staged 03-18."
            rows={2}
            className="w-full resize-none rounded border border-citrus-border bg-transparent px-1.5 py-1 text-[11px] text-citrus-dark outline-none focus:border-red-500/60 dark:border-citrus-night-border dark:text-citrus-night-text"
          />
          <div className="mt-1 flex gap-1">
            <button
              onClick={() => void setVerdict(it, 'rejected', reasonDraft.trim())}
              disabled={!reasonDraft.trim()}
              className="rounded border border-red-500/60 bg-red-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-red-600 disabled:opacity-40 dark:text-red-400"
            >
              Reject
            </button>
            <button
              onClick={() => setRejecting(null)}
              className="rounded border border-citrus-border px-1.5 py-0.5 text-[10px] font-semibold text-citrus-muted dark:border-citrus-night-border dark:text-citrus-night-muted"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-citrus-border px-3 py-1.5 text-[11px] dark:border-citrus-night-border">
        <div className="text-citrus-muted dark:text-citrus-night-muted">
          <span className="font-bold text-citrus-dark dark:text-citrus-night-text">{pending.length}</span> pending
          <span className="mx-1">·</span>
          {resolved.filter((i) => i.verdict === 'approved').length} approved
          <span className="mx-1">·</span>
          {resolved.filter((i) => i.verdict === 'rejected').length} rejected
        </div>
        <label className="flex cursor-pointer items-center gap-1 text-citrus-muted dark:text-citrus-night-muted">
          <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} className="accent-citrus-pink" />
          show reviewed
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {groups.length === 0 && (
          <div className="px-2 py-6 text-center text-[12px] text-citrus-muted dark:text-citrus-night-muted">
            {items.length === 0 ? 'No findings yet — your AI agent records events, leads and negatives here as it works.' : 'Nothing left to review. ✓'}
          </div>
        )}
        {groups.map((g) => {
          const isCollapsed = collapsed.has(g.host)
          const groupPending = g.items.filter((i) => i.verdict === 'pending').length
          return (
            <div key={g.host} className="mb-2">
              <div className="flex items-center gap-1 px-1 pb-1">
                <button onClick={() => toggleGroup(g.host)} className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-citrus-muted dark:text-citrus-night-muted">
                  {isCollapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                  {g.host === '—' ? 'No host' : g.host}
                  <span className="text-citrus-muted/60">· {g.items.length}</span>
                </button>
                {groupPending > 1 && (
                  <button
                    onClick={() => void approveGroup(g)}
                    title={`Approve all ${groupPending} pending in ${g.host}`}
                    className="ml-auto rounded border border-emerald-500/40 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-600 hover:bg-emerald-500/10 dark:text-emerald-400"
                  >
                    Approve {groupPending}
                  </button>
                )}
              </div>
              {!isCollapsed && <div className="space-y-0.5">{g.items.map(row)}</div>}
            </div>
          )
        })}
      </div>

      {pending.some((i) => i.flags.includes('overturned') || i.flags.includes('stale')) && (
        <div className="flex items-center gap-1.5 border-t border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[10px] text-amber-700 dark:text-amber-400">
          <AlertTriangle className="h-3 w-3 shrink-0" />
          Some negatives are stale or overturned — the agent can re-check them with verify_negative.
        </div>
      )}
    </div>
  )
}
