import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Loader2, Pencil, Plus, Save, Trash2, X } from 'lucide-react'
import type { WatchlistInfo, WatchlistKind } from '../../state/enrichTypes'

// The Watchlists editor — a right-side drawer over the Intel tab. Lists are global (app-wide) and
// DB-backed (the worker's watchlists.db). Each list has a kind that decides how it matches an
// indicator at enrichment time (the 'watchlist' provider): ip = IPv4/CIDR containment + IPv6/exact,
// asn = ASN number, domain/hash = exact. Editing is a paste-friendly textarea (one entry per line);
// Save replaces the list and reports how many lines were stored vs skipped (didn't parse).
//
// All confirms/renames are inline (no window.confirm/prompt) — native dialogs block the sandboxed
// renderer and can leave inputs unfocusable, which broke "create a new list after deleting one".

interface KindDef {
  id: WatchlistKind
  label: string
  hint: string
  examples: string[]
}
const KINDS: KindDef[] = [
  {
    id: 'ip',
    label: 'IP / Subnet',
    hint: 'An IPv4, IPv6, or CIDR subnet. An indicator IP matches by exact value or subnet containment.',
    examples: ['8.8.8.8', '10.0.0.0/8', '2001:db8::/32']
  },
  {
    id: 'asn',
    label: 'ASN',
    hint: 'An Autonomous System NUMBER only (with or without the “AS” prefix) — not the org name. An IP matches if its ASN is on the list.',
    examples: ['AS15169', '15169']
  },
  {
    id: 'domain',
    label: 'Domain',
    hint: 'A bare domain / host — no scheme, path, or port. Matches the exact domain.',
    examples: ['example.com', 'bad.sub.example.com']
  },
  {
    id: 'hash',
    label: 'Hash',
    hint: 'A file hash in hex — md5, sha1, or sha256. Matches the exact hash.',
    examples: ['44d88612fea8a8f36de82e1278abb02f']
  }
]
const kindDef = (k: WatchlistKind): KindDef => KINDS.find((x) => x.id === k) ?? KINDS[0]

export function WatchlistsPanel({ open, onClose, onChanged }: {
  open: boolean
  onClose: () => void
  /** Called after any create/edit/delete so the Intel tab can refresh the provider status. */
  onChanged?: () => void
}): JSX.Element | null {
  const [lists, setLists] = useState<WatchlistInfo[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [text, setText] = useState('')
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Inline (non-native) interactions.
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newKind, setNewKind] = useState<WatchlistKind>('ip')
  const [renaming, setRenaming] = useState(false)
  const [renameDraft, setRenameDraft] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)

  const selected = lists.find((l) => l.id === selectedId) ?? null

  const refresh = useCallback(async (selectId?: number): Promise<void> => {
    const ls = await window.api.watchlist.list()
    setLists(ls)
    setSelectedId((cur) => {
      const want = selectId ?? cur
      return want != null && ls.some((l) => l.id === want) ? want : (ls[0]?.id ?? null)
    })
  }, [])

  // Load the lists when the drawer opens; reset transient UI state.
  useEffect(() => {
    if (!open) return
    setCreating(false)
    setRenaming(false)
    setConfirmDelete(false)
    setConfirmClose(false)
    setError(null)
    void refresh()
  }, [open, refresh])

  // Load the selected list's entries into the textarea.
  useEffect(() => {
    setConfirmDelete(false)
    setRenaming(false)
    if (selectedId == null) {
      setText('')
      setDirty(false)
      return
    }
    let live = true
    void window.api.watchlist.entries(selectedId).then((rows) => {
      if (live) {
        setText(rows.join('\n'))
        setDirty(false)
        setSaveMsg(null)
      }
    })
    return () => {
      live = false
    }
  }, [selectedId])

  async function createList(): Promise<void> {
    const name = newName.trim()
    if (!name) return
    setError(null)
    try {
      const info = await window.api.watchlist.create(name, newKind, null)
      setCreating(false)
      setNewName('')
      await refresh(info.id)
      onChanged?.()
    } catch {
      setError(`A list named “${name}” already exists.`)
    }
  }

  async function save(): Promise<void> {
    if (selectedId == null) return
    setBusy(true)
    setError(null)
    try {
      const res = await window.api.watchlist.replace(selectedId, text)
      const parts = [`${res.added} saved`]
      if (res.skipped.length > 0) parts.push(`${res.skipped.length} skipped (didn’t parse)`)
      setSaveMsg(parts.join(' · '))
      setDirty(false)
      await refresh(selectedId)
      onChanged?.()
    } finally {
      setBusy(false)
    }
  }

  async function doDelete(): Promise<void> {
    if (selected == null) return
    setConfirmDelete(false)
    await window.api.watchlist.remove(selected.id)
    await refresh()
    onChanged?.()
  }

  async function commitRename(): Promise<void> {
    const next = renameDraft.trim()
    setRenaming(false)
    if (selected == null || !next || next === selected.name) return
    try {
      await window.api.watchlist.rename(selected.id, next)
      await refresh(selected.id)
      onChanged?.()
    } catch {
      setError(`A list named “${next}” already exists.`)
    }
  }

  // Close, guarding unsaved textarea edits with an inline confirm (no native dialog).
  const attemptClose = useCallback((): void => {
    if (dirty) setConfirmClose(true)
    else onClose()
  }, [dirty, onClose])

  const escRef = useRef(attemptClose)
  escRef.current = attemptClose
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') escRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (!open) return null

  const activeDef = kindDef(selected?.kind ?? newKind)
  const exampleLine = (d: KindDef): string => `e.g. ${d.examples.join('  ·  ')}`

  return (
    // Non-modal: the container ignores pointer events (pointer-events-none) so the rest of the Intel
    // space stays scrollable/clickable; only the panel itself is interactive. Close via X or Escape.
    <div className="watchlists fixed inset-0 z-50 flex justify-end pointer-events-none">
      <aside className="pointer-events-auto relative flex h-full w-[520px] max-w-[92vw] flex-col border-l border-citrus-border bg-citrus-card shadow-xl dark:border-citrus-night-border dark:bg-citrus-night-card">
        {/* Header */}
        <div className="flex items-center justify-between gap-2 border-b border-citrus-border px-4 py-3 dark:border-citrus-night-border">
          <div className="min-w-0">
            <div className="text-sm font-bold text-citrus-dark dark:text-citrus-night-text">Watchlists</div>
            <div className="text-[11px] text-citrus-muted dark:text-citrus-night-muted">
              Curated context lists — match indicators with the “Watchlist” provider.
            </div>
          </div>
          <button onClick={attemptClose} title="Close" className="shrink-0 text-citrus-muted hover:text-citrus-pink dark:text-citrus-night-muted">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* List pills + New */}
        <div className="flex flex-wrap items-center gap-1.5 border-b border-citrus-border/60 px-4 py-2 dark:border-citrus-night-border/60">
          {lists.length === 0 && !creating && (
            <span className="text-[11px] text-citrus-muted dark:text-citrus-night-muted">No lists yet — create one →</span>
          )}
          {lists.map((l) => {
            const active = l.id === selectedId
            return (
              <button
                key={l.id}
                onClick={() => setSelectedId(l.id)}
                className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
                  active
                    ? 'border-citrus-pink/50 bg-citrus-pink-light text-citrus-pink dark:bg-citrus-night-elev'
                    : 'border-citrus-border text-citrus-dark hover:border-citrus-pink/40 dark:border-citrus-night-border dark:text-citrus-night-text'
                }`}
                title={`${kindDef(l.kind).label} · ${l.count} entr${l.count === 1 ? 'y' : 'ies'}`}
              >
                <span className="font-semibold">{l.name}</span>
                <span className={active ? 'text-citrus-pink/80' : 'text-citrus-muted dark:text-citrus-night-muted'}>{l.count}</span>
              </button>
            )
          })}
          <button
            onClick={() => { setCreating(true); setError(null) }}
            className="inline-flex items-center gap-1 rounded-full border border-dashed border-citrus-border px-2 py-0.5 text-[11px] font-semibold text-citrus-muted hover:border-citrus-pink/40 hover:text-citrus-pink dark:border-citrus-night-border dark:text-citrus-night-muted"
          >
            <Plus className="w-3 h-3" /> New
          </button>
        </div>

        {/* New-list form */}
        {creating && (
          <div className="flex flex-col gap-2 border-b border-citrus-border/60 bg-citrus-sand/30 px-4 py-3 dark:border-citrus-night-border/60 dark:bg-citrus-night-elev/40">
            <div className="flex items-center gap-2">
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void createList(); if (e.key === 'Escape') { setCreating(false); setNewName('') } }}
                placeholder="List name (e.g. Corporate)"
                className="min-w-0 flex-1 rounded border border-citrus-border bg-citrus-cream px-2 py-1 text-xs text-citrus-dark outline-none focus:border-citrus-pink dark:border-citrus-night-border dark:bg-citrus-night dark:text-citrus-night-text"
              />
              <button
                onClick={() => void createList()}
                disabled={!newName.trim()}
                className="rounded-md bg-citrus-pink px-2.5 py-1 text-[11px] font-bold text-white hover:bg-citrus-pink-hover disabled:opacity-50"
              >
                Create
              </button>
              <button onClick={() => { setCreating(false); setNewName('') }} className="text-citrus-muted hover:text-citrus-pink dark:text-citrus-night-muted">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {KINDS.map((k) => (
                <button
                  key={k.id}
                  onClick={() => setNewKind(k.id)}
                  className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
                    newKind === k.id
                      ? 'border-citrus-pink/50 bg-citrus-pink-light text-citrus-pink dark:bg-citrus-night-elev'
                      : 'border-citrus-border text-citrus-muted hover:text-citrus-pink dark:border-citrus-night-border dark:text-citrus-night-muted'
                  }`}
                >
                  {k.label}
                </button>
              ))}
            </div>
            <div className="text-[11px] text-citrus-muted dark:text-citrus-night-muted">{kindDef(newKind).hint}</div>
            <div className="font-mono text-[11px] text-citrus-muted/80 dark:text-citrus-night-muted/80">{exampleLine(kindDef(newKind))}</div>
          </div>
        )}

        {/* Selected list editor */}
        {selected ? (
          <>
            <div className="flex items-center gap-2 px-4 pt-3 pb-1 text-xs">
              {renaming ? (
                <input
                  autoFocus
                  value={renameDraft}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onBlur={() => void commitRename()}
                  onKeyDown={(e) => { if (e.key === 'Enter') void commitRename(); if (e.key === 'Escape') setRenaming(false) }}
                  className="min-w-0 flex-1 rounded border border-citrus-pink/50 bg-citrus-cream px-2 py-0.5 text-sm font-bold text-citrus-dark outline-none dark:bg-citrus-night dark:text-citrus-night-text"
                />
              ) : (
                <span className="text-sm font-bold text-citrus-dark dark:text-citrus-night-text">{selected.name}</span>
              )}
              <span className="rounded-full border border-citrus-border px-2 py-0.5 text-[10px] font-semibold text-citrus-muted dark:border-citrus-night-border dark:text-citrus-night-muted">
                {activeDef.label}
              </span>
              <div className="ml-auto flex items-center gap-1">
                {confirmDelete ? (
                  <span className="inline-flex items-center gap-1.5 text-[11px]">
                    <span className="text-citrus-muted dark:text-citrus-night-muted">Delete?</span>
                    <button onClick={() => void doDelete()} className="rounded bg-citrus-pink px-2 py-0.5 text-[11px] font-bold text-white hover:bg-citrus-pink-hover">
                      Delete
                    </button>
                    <button onClick={() => setConfirmDelete(false)} className="rounded border border-citrus-border px-2 py-0.5 text-[11px] font-semibold text-citrus-muted dark:border-citrus-night-border dark:text-citrus-night-muted">
                      Cancel
                    </button>
                  </span>
                ) : (
                  <>
                    <button onClick={() => { setRenameDraft(selected.name); setRenaming(true) }} title="Rename list" className="rounded p-1 text-citrus-muted hover:text-citrus-pink dark:text-citrus-night-muted">
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => setConfirmDelete(true)} title="Delete list" className="rounded p-1 text-citrus-muted hover:text-citrus-pink dark:text-citrus-night-muted">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </>
                )}
              </div>
            </div>

            <div className="px-4 pb-2">
              <div className="text-[11px] text-citrus-muted dark:text-citrus-night-muted">{activeDef.hint}</div>
              <div className="font-mono text-[11px] text-citrus-muted/80 dark:text-citrus-night-muted/80">{exampleLine(activeDef)}</div>
            </div>

            <textarea
              value={text}
              onChange={(e) => { setText(e.target.value); setDirty(true); setSaveMsg(null) }}
              spellCheck={false}
              placeholder={`One entry per line.\n\n${activeDef.examples.join('\n')}`}
              className="flex-1 resize-none border-t border-citrus-border/60 bg-citrus-cream/40 px-4 py-3 font-mono text-xs leading-relaxed text-citrus-dark outline-none placeholder:text-citrus-muted/60 dark:border-citrus-night-border/60 dark:bg-citrus-night dark:text-citrus-night-text"
            />

            {confirmClose ? (
              <div className="flex items-center gap-2 border-t border-citrus-border px-4 py-2.5 dark:border-citrus-night-border">
                <span className="text-[11px] text-amber-600 dark:text-amber-400">Discard unsaved changes?</span>
                <button onClick={onClose} className="ml-auto rounded-md border border-citrus-border px-2.5 py-1 text-[11px] font-bold text-citrus-muted hover:text-citrus-pink dark:border-citrus-night-border dark:text-citrus-night-muted">
                  Discard
                </button>
                <button onClick={() => setConfirmClose(false)} className="rounded-md bg-citrus-pink px-2.5 py-1 text-[11px] font-bold text-white hover:bg-citrus-pink-hover">
                  Keep editing
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2 border-t border-citrus-border px-4 py-2.5 dark:border-citrus-night-border">
                <button
                  onClick={() => void save()}
                  disabled={busy || !dirty}
                  className="inline-flex items-center gap-1.5 rounded-md bg-citrus-pink px-3 py-1 text-[11px] font-bold text-white hover:bg-citrus-pink-hover disabled:opacity-50"
                >
                  {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                  Save
                </button>
                {saveMsg && (
                  <span className="inline-flex items-center gap-1 text-[11px] text-citrus-muted dark:text-citrus-night-muted">
                    <Check className="w-3.5 h-3.5 text-emerald-500" /> {saveMsg}
                  </span>
                )}
                {dirty && !busy && <span className="text-[11px] text-amber-600 dark:text-amber-400">unsaved</span>}
              </div>
            )}
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center px-6 text-center text-[12px] text-citrus-muted dark:text-citrus-night-muted">
            {creating ? 'Name your list and pick a type.' : 'Create a watchlist to get started.'}
          </div>
        )}

        {error && <div className="border-t border-citrus-border px-4 py-2 text-[11px] text-citrus-pink-hover dark:border-citrus-night-border">{error}</div>}
      </aside>
    </div>
  )
}
