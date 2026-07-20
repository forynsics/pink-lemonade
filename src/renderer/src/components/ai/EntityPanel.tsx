import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Bot, HardDriveDownload, Monitor, Plus, Trash2, User, UserRound, X } from 'lucide-react'
import type { CsvEntity } from '../../state/csvTypes'
import { ENTITY_STATUS_LABELS, ENTITY_STATUSES, type EntityStatus } from '../../../../shared/entities'
import { usePanelWidth } from '../../state/panelWidth'

// SYSTEMS & ACCOUNTS — the subjects of the case, in one panel with two sections.
//
// The list is never empty for a case with data in it: every host that produced a source and every
// account the recorded events involve is derived, and curation is an overlay on top. So this opens
// showing what the case already knows, rather than an empty form waiting to be filled in.
//
// The COLLECTION GAP banner is the reason the panel earns its space. A host that appears in the data
// but whose artifacts nobody pulled is the most actionable thing an investigation produces, and it
// used to survive only as a line of prose in a report.

const STATUS_STYLE: Record<EntityStatus, string> = {
  compromised: 'border-red-500/50 bg-red-500/10 text-red-600 dark:text-red-400',
  suspected: 'border-amber-500/50 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  cleared: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  unknown: 'border-citrus-border text-citrus-muted dark:border-citrus-night-border dark:text-citrus-night-muted'
}

export function EntityPanel({
  open,
  onClose,
  wsId,
  refreshKey
}: {
  open: boolean
  onClose: () => void
  wsId: string | null
  refreshKey: number
}): JSX.Element | null {
  const [entities, setEntities] = useState<CsvEntity[]>([])
  const [adding, setAdding] = useState<'system' | 'account' | null>(null)
  const [draft, setDraft] = useState('')
  // Which row is awaiting delete confirmation. Removing a subject of the case is not a click-through.
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const { width, setWidth, clamp } = usePanelWidth({ key: 'pink-lemonade:panel-w:entities', min: 320, max: 720, defaultFraction: 0.28 })

  const reload = useCallback(async (): Promise<void> => {
    if (!wsId) {
      setEntities([])
      return
    }
    setEntities(await window.api.csv.wsEntityList(wsId))
  }, [wsId])

  useEffect(() => {
    if (open) void reload()
  }, [open, reload, refreshKey])

  const systems = useMemo(() => entities.filter((e) => e.kind === 'system'), [entities])
  const accounts = useMemo(() => entities.filter((e) => e.kind === 'account'), [entities])
  // Any system we don't hold data for, asserted or evidenced — see uncollectedSystems for why
  // this is not gated on evidence.
  const gaps = useMemo(() => systems.filter((e) => !e.collected), [systems])

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

  async function setStatus(e: CsvEntity, status: EntityStatus): Promise<void> {
    if (!wsId) return
    await window.api.csv.wsEntityUpsert(wsId, { kind: e.kind, name: e.name, status })
    await reload()
  }

  /**
   * Remove an entity's curated record.
   *
   * A DERIVED entity cannot truly be deleted — if a source came from that host, or an event involves
   * that account, the case's own data still says so and no button should be able to un-say it. For
   * those, this reverts the curation (status, notes, role) and the row stays, honestly. For an entry
   * someone typed in, the record IS the entity, so it disappears. The confirm text says which.
   */
  async function remove(e: CsvEntity): Promise<void> {
    if (!wsId) return
    await window.api.csv.wsEntityDelete(wsId, e.id)
    setConfirmId(null)
    await reload()
  }

  async function add(): Promise<void> {
    const name = draft.trim()
    if (!wsId || !name || !adding) return
    await window.api.csv.wsEntityUpsert(wsId, { kind: adding, name })
    setDraft('')
    setAdding(null)
    await reload()
  }

  if (!open) return null

  const row = (e: CsvEntity): JSX.Element => (
    <div key={e.id} className="group rounded-md px-2 py-1.5 text-[12px] hover:bg-citrus-sand/50 dark:hover:bg-citrus-night-elev">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-mono font-semibold text-citrus-dark dark:text-citrus-night-text" title={e.name}>
              {e.name}
            </span>
            {/* WHO added it, rather than an "asserted" badge: for an entry the data doesn't back,
                the author is what tells an analyst how far to trust it. Nothing shows for an entity
                that came out of the data itself — there is no author to name. */}
            {e.actor && (
              <span
                className="inline-flex shrink-0 items-center gap-0.5 rounded border border-citrus-border px-1 text-[9px] font-bold uppercase text-citrus-muted dark:border-citrus-night-border dark:text-citrus-night-muted"
                title={e.actor === 'ai' ? 'Added by your AI agent' : 'Added by you'}
              >
                {e.actor === 'ai' ? <Bot className="h-2.5 w-2.5" /> : <UserRound className="h-2.5 w-2.5" />}
                {e.actor === 'ai' ? 'AI' : 'Analyst'}
              </span>
            )}
            {/* Collection resolved by INFERENCE, not by the entity being a source group itself.
                Shown because two domains can share a short host name — the analyst should be able to
                see that this one was worked out rather than known. */}
            {e.collected && e.collectedVia && e.collectedVia !== 'group' && (
              <span
                className="shrink-0 rounded border border-citrus-border px-1 text-[9px] font-bold uppercase text-citrus-muted dark:border-citrus-night-border dark:text-citrus-night-muted"
                title={
                  e.collectedVia === 'shortName'
                    ? 'Matched to a collected host by short name — verify if two domains could share it'
                    : 'Resolved to a collected host through a confirmed alias'
                }
              >
                {e.collectedVia === 'shortName' ? 'matched' : 'via alias'}
              </span>
            )}
            {e.kind === 'system' && !e.collected && (
              <span className="inline-flex shrink-0 items-center gap-0.5 rounded border border-amber-500/50 bg-amber-500/10 px-1 text-[9px] font-bold uppercase text-amber-600 dark:text-amber-400" title="Named in the data, but its artifacts were never collected — you cannot pivot into it">
                <HardDriveDownload className="h-2.5 w-2.5" /> not collected
              </span>
            )}
          </div>
          {e.role && <div className="truncate text-[10px] text-citrus-muted dark:text-citrus-night-muted">{e.role}</div>}
          {e.notes && <div className="mt-0.5 text-[10px] leading-snug text-citrus-muted dark:text-citrus-night-muted">{e.notes}</div>}
          {e.aliases.length > 0 && (
            <div className="truncate text-[10px] text-citrus-muted dark:text-citrus-night-muted">also: {e.aliases.join(', ')}</div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {e.eventCount > 0 && <div className="text-[10px] text-citrus-muted dark:text-citrus-night-muted">{e.eventCount} event{e.eventCount === 1 ? '' : 's'}</div>}
          <button
            onClick={() => setConfirmId(confirmId === e.id ? null : e.id)}
            title="Remove"
            className="rounded p-0.5 text-citrus-muted opacity-0 transition-opacity group-hover:opacity-100 hover:text-red-600 dark:text-citrus-night-muted"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {confirmId === e.id && (
        <div className="mt-1 rounded border border-red-500/40 bg-red-500/5 px-2 py-1.5">
          <div className="text-[10px] leading-snug text-citrus-dark dark:text-citrus-night-text">
            {e.evidenced ? (
              <>
                The case&apos;s own data names <span className="font-mono font-semibold">{e.name}</span>, so it stays
                listed. This clears what was recorded about it — status, role and notes.
              </>
            ) : (
              <>
                Remove <span className="font-mono font-semibold">{e.name}</span> from the case? Nothing in the data
                references it, so it will be gone.
              </>
            )}
          </div>
          <div className="mt-1 flex gap-1">
            <button
              onClick={() => void remove(e)}
              className="rounded border border-red-500/60 bg-red-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-red-600 dark:border-red-400/60 dark:text-red-400"
            >
              {e.evidenced ? 'Clear notes' : 'Remove'}
            </button>
            <button
              onClick={() => setConfirmId(null)}
              className="rounded border border-citrus-border px-1.5 py-0.5 text-[10px] font-semibold text-citrus-muted dark:border-citrus-night-border dark:text-citrus-night-muted"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      <div className="mt-1 flex flex-wrap gap-1">
        {ENTITY_STATUSES.map((s) => (
          <button
            key={s}
            onClick={() => void setStatus(e, s)}
            className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold transition-colors ${
              e.status === s ? STATUS_STYLE[s] : 'border-transparent text-citrus-muted hover:text-citrus-pink dark:text-citrus-night-muted'
            }`}
          >
            {ENTITY_STATUS_LABELS[s]}
          </button>
        ))}
      </div>
    </div>
  )

  const section = (
    title: string,
    kind: 'system' | 'account',
    Icon: typeof Monitor,
    items: CsvEntity[]
  ): JSX.Element => (
    <div className="mb-3">
      <div className="flex items-center justify-between px-1 pb-1">
        <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-citrus-muted dark:text-citrus-night-muted">
          <Icon className="h-3 w-3" /> {title} <span className="text-citrus-muted/60">· {items.length}</span>
        </div>
        <button onClick={() => setAdding(adding === kind ? null : kind)} title={`Add a ${kind}`} className="rounded p-0.5 text-citrus-muted hover:text-citrus-pink dark:text-citrus-night-muted">
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
      {adding === kind && (
        <div className="mb-1 flex gap-1 px-1">
          <input
            autoFocus
            value={draft}
            onChange={(ev) => setDraft(ev.target.value)}
            onKeyDown={(ev) => {
              if (ev.key === 'Enter') void add()
              if (ev.key === 'Escape') setAdding(null)
            }}
            placeholder={kind === 'system' ? 'Host name' : 'Account name'}
            className="min-w-0 flex-1 rounded border border-citrus-border bg-transparent px-1.5 py-0.5 font-mono text-[11px] text-citrus-dark outline-none focus:border-citrus-pink dark:border-citrus-night-border dark:text-citrus-night-text"
          />
          <button onClick={() => void add()} className="rounded border border-citrus-border px-1.5 text-[11px] font-semibold text-citrus-dark hover:border-citrus-pink/40 hover:text-citrus-pink dark:border-citrus-night-border dark:text-citrus-night-text">
            Add
          </button>
        </div>
      )}
      {items.length === 0 ? (
        <div className="px-2 py-2 text-[11px] text-citrus-muted dark:text-citrus-night-muted">None yet.</div>
      ) : (
        <div className="space-y-0.5">{items.map(row)}</div>
      )}
    </div>
  )

  return (
    <aside
      className="entity-panel relative flex min-h-0 shrink-0 flex-col border-l border-citrus-border bg-citrus-card dark:border-citrus-night-border dark:bg-citrus-night-card"
      style={{ width }}
    >
      <div className="absolute left-0 top-0 z-10 h-full w-1 cursor-col-resize hover:bg-citrus-pink/40" onMouseDown={startResize} title="Drag to resize" />

      <div className="flex items-center justify-between gap-2 border-b border-citrus-border px-4 py-3 dark:border-citrus-night-border">
        <div className="flex min-w-0 items-center gap-2">
          <Monitor className="h-4 w-4 shrink-0 text-citrus-pink" />
          <div className="min-w-0">
            <div className="text-sm font-bold text-citrus-dark dark:text-citrus-night-text">Systems &amp; Accounts</div>
            <div className="text-[11px] text-citrus-muted dark:text-citrus-night-muted">
              {systems.length} system{systems.length === 1 ? '' : 's'} · {accounts.length} account{accounts.length === 1 ? '' : 's'}
            </div>
          </div>
        </div>
        <button onClick={onClose} title="Close" className="shrink-0 rounded p-1 text-citrus-muted hover:text-citrus-pink dark:text-citrus-night-muted">
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* The collection gap, stated up front: these are hosts you cannot pivot into. */}
      {gaps.length > 0 && (
        <div className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-2">
          <div className="flex items-center gap-1.5 text-[11px] font-bold text-amber-700 dark:text-amber-400">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            {gaps.length} system{gaps.length === 1 ? '' : 's'} with no data collected
          </div>
          <div className="mt-0.5 text-[10px] leading-snug text-amber-700/80 dark:text-amber-400/80">
            The data names {gaps.length === 1 ? 'it' : 'them'}, but no artifacts were ever pulled — so nothing here can be pivoted into.
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {entities.length === 0 && (
          <div className="px-2 py-6 text-center text-[12px] text-citrus-muted dark:text-citrus-night-muted">
            Nothing yet — import evidence, or add a host or account you already suspect.
          </div>
        )}
        {section('Systems', 'system', Monitor, systems)}
        {section('Accounts', 'account', User, accounts)}
      </div>
    </aside>
  )
}
