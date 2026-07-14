import { useEffect, useState } from 'react'
import { Network, X } from 'lucide-react'
import type { CsvEvent } from '../../state/csvTypes'

// Record an analyst's OWN event from selected grid rows — the analyst's interpretation, grounded in real
// rows (the rows are kept as evidence; the source data is never modified). Mirrors CellPopout's modal shell.
// The rows can either start a NEW event or be ATTACHED as corroborating evidence to an existing one
// (pick it from the dropdown) — the existing event's interpretation is preserved; only its evidence grows.

const field =
  'w-full rounded border border-citrus-border bg-citrus-bg px-2 py-1.5 text-[12px] text-citrus-dark outline-none focus:border-citrus-pink/60 dark:border-citrus-night-border dark:bg-citrus-night-bg dark:text-citrus-night-text'

const NEW = '__new__'

export type RecordEventSubmit =
  | { kind: 'new'; label: string; description: string | null; technique: string | null; users: string[] }
  | { kind: 'existing'; eventId: string }

export function RecordEventDialog({
  rowCount,
  sourceName,
  wsId,
  onSubmit,
  onClose
}: {
  rowCount: number
  sourceName: string
  /** Workspace whose existing events feed the "attach to existing" dropdown. */
  wsId: string
  onSubmit: (payload: RecordEventSubmit) => void
  onClose: () => void
}): JSX.Element {
  const [target, setTarget] = useState<string>(NEW)
  const [events, setEvents] = useState<CsvEvent[]>([])
  const [label, setLabel] = useState('')
  const [technique, setTechnique] = useState('')
  const [users, setUsers] = useState('')
  const [description, setDescription] = useState('')

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    let live = true
    void window.api.csv.wsEventList(wsId).then((evs) => {
      if (live) setEvents(evs)
    })
    return () => {
      live = false
    }
  }, [wsId])

  const isNew = target === NEW
  const chosen = events.find((e) => e.id === target)

  const submit = (): void => {
    if (isNew) {
      const l = label.trim()
      if (!l) return
      onSubmit({
        kind: 'new',
        label: l,
        description: description.trim() || null,
        technique: technique.trim() || null,
        users: users.split(',').map((u) => u.trim()).filter(Boolean)
      })
    } else {
      onSubmit({ kind: 'existing', eventId: target })
    }
  }

  const canSubmit = isNew ? !!label.trim() : !!chosen

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25" onClick={onClose}>
      <div
        className="flex w-[min(520px,92vw)] flex-col rounded-xl border border-citrus-border bg-citrus-card shadow-lg dark:border-citrus-night-border dark:bg-citrus-night-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-citrus-border px-4 py-2.5 dark:border-citrus-night-border">
          <span className="inline-flex items-center gap-1.5 text-xs font-bold text-citrus-dark dark:text-citrus-night-text">
            <Network className="h-3.5 w-3.5 text-citrus-pink" /> Record event from {rowCount} row{rowCount === 1 ? '' : 's'}
          </span>
          <button onClick={onClose} title="Close (Esc)" className="text-citrus-muted hover:text-citrus-pink">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex flex-col gap-2.5 p-4">
          <div className="text-[11px] text-citrus-muted dark:text-citrus-night-muted">
            {isNew ? (
              <>
                Your interpretation of the selected rows in <span className="font-mono">{sourceName}</span> — kept as evidence.
              </>
            ) : (
              <>
                Attach the selected rows in <span className="font-mono">{sourceName}</span> to an existing event as evidence.
              </>
            )}
          </div>

          {/* Target: a new event, or attach to an existing one. */}
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-bold uppercase tracking-wide text-citrus-muted dark:text-citrus-night-muted">Event</span>
            <select value={target} onChange={(e) => setTarget(e.target.value)} className={field}>
              <option value={NEW}>➕ New event…</option>
              {events.length > 0 && (
                <optgroup label="Attach to existing event">
                  {events.map((ev) => (
                    <option key={ev.id} value={ev.id}>
                      {ev.label}
                      {ev.actor === 'analyst' ? ' (yours)' : ''}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </label>

          {isNew ? (
            <>
              <input
                autoFocus
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submit()
                }}
                placeholder="What happened"
                className={field}
              />
              <input value={technique} onChange={(e) => setTechnique(e.target.value)} placeholder="ATT&CK technique (T1059.001)" className={field} />
              <input value={users} onChange={(e) => setUsers(e.target.value)} placeholder="User accounts, comma-separated" className={field} />
              <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="Description" className={`${field} resize-y`} />
            </>
          ) : (
            chosen && (
              <div className="rounded border border-citrus-border bg-citrus-bg px-2.5 py-2 text-[11px] dark:border-citrus-night-border dark:bg-citrus-night-bg">
                <div className="font-semibold text-citrus-dark dark:text-citrus-night-text">{chosen.label}</div>
                {chosen.technique && <div className="mt-0.5 text-citrus-pink">{chosen.technique}</div>}
                {chosen.description && <div className="mt-0.5 text-citrus-muted dark:text-citrus-night-muted">{chosen.description}</div>}
                <div className="mt-1 text-[10px] text-citrus-muted dark:text-citrus-night-muted">
                  {chosen.evidence.length} existing evidence item{chosen.evidence.length === 1 ? '' : 's'} — these {rowCount} row{rowCount === 1 ? '' : 's'} will be added.
                </div>
              </div>
            )
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-citrus-border px-4 py-2.5 dark:border-citrus-night-border">
          <button
            onClick={onClose}
            className="rounded-md border border-citrus-border px-3 py-1 text-[11px] font-bold text-citrus-dark hover:bg-citrus-sand/60 dark:border-citrus-night-border dark:text-citrus-night-text dark:hover:bg-citrus-night-elev"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!canSubmit}
            className="rounded-md bg-citrus-pink px-3 py-1 text-[11px] font-bold text-white hover:bg-citrus-pink-hover disabled:opacity-40"
          >
            {isNew ? 'Record event' : 'Add to event'}
          </button>
        </div>
      </div>
    </div>
  )
}
