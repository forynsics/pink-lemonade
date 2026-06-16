import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Check, Copy, Database, Download, Eraser, FilePlus, FolderOpen, KeyRound, ListChecks, ListTree, Loader2, Plus, Radar, RefreshCw, Trash2, X } from 'lucide-react'
import { classifyIndicator } from '../../tools/ioc/classify'
import { WatchlistsPanel } from './WatchlistsPanel'
import type { EnrichmentDoc } from '../../state/documents'
import type { EnrichCachedRow, EnrichItem, EnrichProgress, EnrichProviderInfo, EnrichResultRow } from '../../state/enrichTypes'

// The dedicated Enrichment tab: a curated list of indicators (rows) × threat-intel providers
// (column "buckets"). You ADD indicators to the list (no lookup), then SELECT rows and right-click →
// "Enrich with <provider>" to run a given provider against just those rows. Providers run
// independently and accumulate side-by-side, so one pane compares every provider per indicator.
// Lookups are cache-first in the worker; the indicator list persists, results re-read on demand.

// indicator value -> providerId -> that provider's result
type ResultMap = Record<string, Record<string, EnrichResultRow>>

let lookupCounter = 1

// Preferred column order for known fields (others keep first-seen order, appended after).
const FIELD_ORDER = ['Country', 'Region', 'City', 'Continent', 'Lat/Lon', 'ASN', 'Org']
function orderFields(keys: string[]): string[] {
  return [...keys].sort((a, b) => {
    const ia = FIELD_ORDER.indexOf(a)
    const ib = FIELD_ORDER.indexOf(b)
    if (ia === -1 && ib === -1) return 0
    if (ia === -1) return 1
    if (ib === -1) return -1
    return ia - ib
  })
}

const STATUS_STYLE: Record<string, string> = {
  ok: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  notfound: 'bg-citrus-sand text-citrus-muted dark:bg-citrus-night-elev dark:text-citrus-night-muted',
  error: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  skipped: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  private: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300'
}

/** A value cell with a hover "copy" button (copies just that cell) and a wrap/truncate mode. */
function ValueCell({ text, wrap, mono, muted }: { text: string; wrap: boolean; mono?: boolean; muted?: boolean }): JSX.Element {
  const [done, setDone] = useState(false)
  return (
    <td
      className={`relative group px-2 py-1 ${wrap ? 'whitespace-normal break-words max-w-[16rem]' : 'whitespace-nowrap'} ${
        mono ? 'font-mono' : ''
      } ${muted ? 'text-citrus-muted dark:text-citrus-night-muted' : 'text-citrus-dark dark:text-citrus-night-text'}`}
    >
      {text}
      {text !== '' && (
        <button
          className="absolute right-0.5 top-1 opacity-0 group-hover:opacity-100 text-citrus-muted hover:text-citrus-pink"
          title="Copy value"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            void navigator.clipboard.writeText(text)
            setDone(true)
            window.setTimeout(() => setDone(false), 900)
          }}
        >
          {done ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
        </button>
      )}
    </td>
  )
}

export function EnrichmentView({
  doc,
  visible,
  defaultDbPath,
  onPatch,
  onOpenIntelDb,
  onNewIntelDb
}: {
  doc: EnrichmentDoc
  visible: boolean
  defaultDbPath: string
  onPatch: (patch: Partial<EnrichmentDoc>) => void
  onOpenIntelDb: () => void
  onNewIntelDb: () => void
}): JSX.Element {
  const [providers, setProviders] = useState<EnrichProviderInfo[]>([])
  const [watchlistsOpen, setWatchlistsOpen] = useState(false)
  const [results, setResults] = useState<ResultMap>({})
  const [entryCount, setEntryCount] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number; current: string } | null>(null)
  const reqRef = useRef(0)

  // Row selection (by indicator value) + the right-click menu that enriches the selection.
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [menu, setMenu] = useState<{ x: number; y: number; targets: string[] } | null>(null)
  const [sort, setSort] = useState<{ id: string; dir: 'asc' | 'desc' } | null>(null)
  const [wrap, setWrap] = useState(false)
  const [addNote, setAddNote] = useState<string | null>(null)
  const [exportOpen, setExportOpen] = useState(false)
  // Excel-like row highlight (the "active" rows): click to highlight one, Shift+Arrow to extend.
  // Independent of the tick boxes — the header checkbox ticks the highlighted rows.
  const [highlighted, setHighlighted] = useState<Set<string>>(new Set())
  const anchorRef = useRef(-1)
  const focusRef = useRef(-1)
  const dragRef = useRef(false) // true while a mouse row-drag is in progress
  const gridRef = useRef<HTMLDivElement>(null)
  const headerBoxRef = useRef<HTMLInputElement>(null)

  // Resizable paste box (full-width bottom drag bar).
  const [paneH, setPaneH] = useState(56)

  // MaxMind setup state (download GeoLite2 with the user's free license key).
  const [keyDraft, setKeyDraft] = useState('')
  const [hasKey, setHasKey] = useState(false)
  const [setup, setSetup] = useState<{ editionId: string; pct: number } | null>(null)
  const [setupErr, setSetupErr] = useState<string | null>(null)
  const setupBusy = setup !== null

  const refreshProviders = useCallback(() => {
    void window.api.enrich.providers().then(setProviders)
  }, [])
  useEffect(refreshProviders, [refreshProviders])
  useEffect(() => {
    void window.api.enrich.hasKey().then(setHasKey)
  }, [])
  useEffect(() => {
    return window.api.enrich.onSetupProgress((p) => {
      const ev = p as { editionId: string; received: number; total: number }
      setSetup({ editionId: ev.editionId, pct: ev.total > 0 ? Math.round((ev.received / ev.total) * 100) : 0 })
    })
  }, [])
  useEffect(() => {
    return window.api.enrich.onProgress((p) => {
      const ev = p as EnrichProgress
      if (ev.reqId === reqRef.current) setProgress({ done: ev.done, total: ev.total, current: ev.current })
    })
  }, [])

  const maxmind = providers.find((p) => p.id === 'maxmind')

  // Look up `items` against one provider, writing to this tab's intel DB and merging results.
  const runLookup = useCallback((providerId: string, items: EnrichItem[]) => {
    if (items.length === 0 || !doc.dbPath) return
    const reqId = ++lookupCounter
    reqRef.current = reqId
    setBusy(true)
    setProgress({ done: 0, total: items.length, current: '' })
    window.api.enrich
      .bulk(reqId, doc.dbPath, providerId, items)
      .then((res) => {
        if (reqRef.current !== reqId || res.canceled) return
        setResults((prev) => {
          const next: ResultMap = { ...prev }
          for (const row of res.rows) next[row.indicator] = { ...(next[row.indicator] ?? {}), [providerId]: row }
          return next
        })
      })
      .finally(() => {
        if (reqRef.current === reqId) {
          setBusy(false)
          setProgress(null)
          if (doc.dbPath) void window.api.enrich.cacheCount(doc.dbPath).then(setEntryCount)
        }
      })
  }, [doc.dbPath])

  function cancel(): void {
    reqRef.current = 0
    window.api.enrich.cancel()
    setBusy(false)
    setProgress(null)
  }

  // Merge cache-read rows into the matrix (marked fromCache). Never overwrites a row already present
  // (a fresh lookup this session wins over a stale cache read).
  const mergeCacheRows = useCallback((rows: EnrichCachedRow[]) => {
    if (rows.length === 0) return
    setResults((prev) => {
      const next: ResultMap = { ...prev }
      for (const r of rows) {
        const byP = next[r.indicator] ?? {}
        if (byP[r.provider]) continue
        next[r.indicator] = {
          ...byP,
          [r.provider]: { indicator: r.indicator, kind: r.kind, status: r.status, fields: r.fields, fromCache: true, fetchedAt: r.fetchedAt }
        }
      }
      return next
    })
  }, [])

  // End a row-drag wherever the mouse is released.
  useEffect(() => {
    const onUp = (): void => {
      dragRef.current = false
    }
    window.addEventListener('mouseup', onUp)
    return () => window.removeEventListener('mouseup', onUp)
  }, [])

  // Resolve which intel DB this tab uses: a migrated/blank doc binds to the default DB.
  useEffect(() => {
    if (doc.dbPath) return
    void (defaultDbPath ? Promise.resolve(defaultDbPath) : window.api.enrich.defaultDb()).then((p) => {
      if (p) onPatch({ dbPath: p, name: p === defaultDbPath ? 'Global Intel' : p.split(/[\\/]/).pop()?.replace(/\.db$/i, '') || 'intel' })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.dbPath, defaultDbPath])

  // When the bound DB is known/changes: fetch its entry count and load any already-cached values
  // for the persisted indicators (cache read, no lookup).
  useEffect(() => {
    if (!doc.dbPath) return
    void window.api.enrich.cacheCount(doc.dbPath).then(setEntryCount)
    if (doc.indicators.length > 0) {
      void window.api.enrich.cacheGet(doc.dbPath, doc.indicators.map((i) => i.value)).then(mergeCacheRows)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.dbPath])

  // Add: parse the paste box, classify, append NEW indicators. No lookup (that's explicit). Tokens
  // that don't match any indicator pattern are KEPT in the box (so you can see + fix/remove them
  // rather than have them silently vanish); a note summarizes what happened.
  function addFromDraft(): void {
    const tokens = doc.draft.split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean)
    const have = new Set(doc.indicators.map((i) => i.value))
    const added: EnrichItem[] = []
    const unrecognized: string[] = []
    let dupes = 0
    for (const t of tokens) {
      const kind = classifyIndicator(t)
      if (!kind) {
        if (!unrecognized.includes(t)) unrecognized.push(t)
        continue
      }
      if (have.has(t)) {
        dupes++
        continue
      }
      have.add(t)
      added.push({ value: t, kind })
    }
    // Recognized + new go to the list; dupes are dropped (already listed); unrecognized stay in the box.
    onPatch({ draft: unrecognized.join('\n'), ...(added.length > 0 ? { indicators: [...doc.indicators, ...added] } : {}) })
    if (added.length > 0 && doc.dbPath) void window.api.enrich.cacheGet(doc.dbPath, added.map((i) => i.value)).then(mergeCacheRows)
    const parts: string[] = []
    if (added.length) parts.push(`added ${added.length}`)
    if (dupes) parts.push(`${dupes} already listed`)
    if (unrecognized.length) parts.push(`${unrecognized.length} not recognized`)
    setAddNote(parts.length ? parts.join(' · ') : null)
  }

  function highlightRange(a: number, b: number): void {
    const lo = Math.min(a, b)
    const hi = Math.max(a, b)
    setHighlighted(new Set(sortedIndicators.slice(lo, hi + 1).map((i) => i.value)))
  }
  // Mouse: press a row to highlight it; drag across rows to highlight a range (Excel/CSV-grid style).
  // Highlight is the "active" selection and does NOT tick the row.
  function beginRow(index: number, value: string): void {
    setHighlighted(new Set([value]))
    anchorRef.current = index
    focusRef.current = index
    dragRef.current = true
    gridRef.current?.focus()
  }
  function enterRow(index: number): void {
    if (!dragRef.current) return
    focusRef.current = index
    highlightRange(anchorRef.current, index)
  }
  // Arrow keys move the highlight; Shift+Arrow extends it (Excel-style).
  function onGridKeyDown(e: React.KeyboardEvent): void {
    if ((e.key !== 'ArrowDown' && e.key !== 'ArrowUp') || sortedIndicators.length === 0) return
    e.preventDefault()
    if (focusRef.current < 0) {
      anchorRef.current = 0
      focusRef.current = 0
      setHighlighted(new Set([sortedIndicators[0].value]))
      return
    }
    const next = Math.min(sortedIndicators.length - 1, Math.max(0, focusRef.current + (e.key === 'ArrowDown' ? 1 : -1)))
    focusRef.current = next
    if (e.shiftKey) {
      highlightRange(anchorRef.current, next)
    } else {
      anchorRef.current = next
      setHighlighted(new Set([sortedIndicators[next].value]))
    }
  }
  // Header checkbox escalates so there's always a path to "tick everything":
  //  • everything already ticked        → clear all
  //  • some rows highlighted, not all ticked → tick those highlighted rows
  //  • nothing highlighted, or the highlighted ones are already ticked → tick ALL rows
  function onHeaderToggle(): void {
    const n = doc.indicators.length
    if (n > 0 && selected.size === n) {
      setSelected(new Set())
      return
    }
    const hi = [...highlighted]
    if (hi.length > 0 && !hi.every((v) => selected.has(v))) {
      setSelected((prev) => new Set([...prev, ...hi]))
      return
    }
    setSelected(new Set(doc.indicators.map((i) => i.value)))
  }

  function clearAll(): void {
    onPatch({ indicators: [], draft: '' })
    setResults({})
    setSelected(new Set())
    setHighlighted(new Set())
  }

  // --- selection ---
  function toggleRow(value: string): void {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(value)) next.delete(value)
      else next.add(value)
      return next
    })
  }
  const allSelected = doc.indicators.length > 0 && selected.size === doc.indicators.length
  function toggleAll(): void {
    setSelected(allSelected ? new Set() : new Set(doc.indicators.map((i) => i.value)))
  }
  // Header checkbox shows a dash when only some rows are ticked.
  useEffect(() => {
    if (headerBoxRef.current) headerBoxRef.current.indeterminate = selected.size > 0 && !allSelected
  }, [selected, allSelected])

  function openMenu(e: React.MouseEvent, value: string): void {
    e.preventDefault()
    // Act on the ticked set if this row is ticked; else the highlight if this row is highlighted;
    // else just this row (and highlight it). No forced ticking.
    let targets: string[]
    if (selected.has(value) && selected.size > 0) targets = [...selected]
    else if (highlighted.has(value) && highlighted.size > 0) targets = [...highlighted]
    else {
      targets = [value]
      setHighlighted(new Set([value]))
    }
    setMenu({ x: e.clientX, y: e.clientY, targets })
  }
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(null)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  function enrichTargets(providerId: string, targets: string[]): void {
    const items = doc.indicators.filter((i) => targets.includes(i.value))
    runLookup(providerId, items)
    setMenu(null)
  }
  // Drop cached results for these indicators (every provider). The rows stay in the list and go
  // blank, so the next Enrich fetches fresh.
  function clearCacheTargets(targets: string[]): void {
    if (doc.dbPath) {
      void window.api.enrich.cacheDelete(doc.dbPath, targets).then(() => {
        void window.api.enrich.cacheCount(doc.dbPath).then(setEntryCount)
      })
    }
    setResults((prev) => {
      const next = { ...prev }
      for (const t of targets) delete next[t]
      return next
    })
    setMenu(null)
  }

  // "Load all": pull every entry in the bound DB into the working list + results (capped).
  function loadAll(): void {
    if (!doc.dbPath) return
    void window.api.enrich.cacheDump(doc.dbPath).then((rows) => {
      const have = new Set(doc.indicators.map((i) => i.value))
      const seen = new Set<string>()
      const add: EnrichItem[] = []
      for (const r of rows) {
        if (have.has(r.indicator) || seen.has(r.indicator)) continue
        seen.add(r.indicator)
        add.push({ value: r.indicator, kind: r.kind as EnrichItem['kind'] })
      }
      if (add.length > 0) onPatch({ indicators: [...doc.indicators, ...add] })
      mergeCacheRows(rows)
      setAddNote(rows.length >= 5000 ? 'loaded first 5,000 entries from the database' : `loaded ${add.length} from the database`)
    })
  }

  function removeTargets(targets: string[]): void {
    const drop = new Set(targets)
    onPatch({ indicators: doc.indicators.filter((i) => !drop.has(i.value)) })
    setResults((prev) => {
      const next = { ...prev }
      for (const t of targets) delete next[t]
      return next
    })
    setSelected(new Set())
    setMenu(null)
  }

  // --- paste-box resize (drag the bottom bar) ---
  const startResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const startY = e.clientY
      const startH = paneH
      const onMove = (ev: MouseEvent): void => setPaneH(Math.min(400, Math.max(48, startH + (ev.clientY - startY))))
      const onUp = (): void => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [paneH]
  )

  async function pickDb(): Promise<void> {
    const path = await window.api.enrich.pickMmdb()
    if (path) refreshProviders()
  }
  async function runSetup(): Promise<void> {
    setSetupErr(null)
    setSetup({ editionId: '…', pct: 0 })
    const res = await window.api.enrich.maxmindSetup(keyDraft.trim() || undefined)
    setSetup(null)
    if (res.ok) {
      setHasKey(true)
      setKeyDraft('')
      refreshProviders()
    } else {
      setSetupErr(res.error)
    }
  }

  // Provider buckets to render + each bucket's field columns.
  const providerIds = useMemo(() => {
    const seen: string[] = []
    for (const ind of doc.indicators) {
      const byP = results[ind.value]
      if (byP) for (const pid of Object.keys(byP)) if (!seen.includes(pid)) seen.push(pid)
    }
    return seen
  }, [results, doc.indicators])
  const fieldsByProvider = useMemo(() => {
    const m: Record<string, string[]> = {}
    for (const ind of doc.indicators) {
      const byP = results[ind.value]
      if (!byP) continue
      for (const pid of Object.keys(byP)) {
        const arr = m[pid] ?? (m[pid] = [])
        for (const k of Object.keys(byP[pid].fields)) if (!arr.includes(k)) arr.push(k)
      }
    }
    for (const pid of Object.keys(m)) m[pid] = orderFields(m[pid])
    return m
  }, [results, doc.indicators])
  const providerName = (pid: string): string => providers.find((p) => p.id === pid)?.name ?? pid
  const pct = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0

  // --- sorting (presentation only; the persisted indicator list is never reordered) ---
  // Column id: 'ind' | 'kind' | `p:<pid>:status` | `p:<pid>:source` | `p:<pid>:f:<field>`.
  function sortValue(ind: EnrichItem, id: string): string {
    if (id === 'ind') return ind.value
    if (id === 'kind') return ind.kind
    const parts = id.split(':')
    if (parts[0] === 'p') {
      const r = results[ind.value]?.[parts[1]]
      if (parts[2] === 'status') return r?.status ?? ''
      if (parts[2] === 'source') return r ? (r.fromCache ? 'cached' : 'fresh') : ''
      if (parts[2] === 'f') return r?.fields[parts.slice(3).join(':')] ?? ''
    }
    return ''
  }
  function toggleSort(id: string): void {
    setSort((s) => (s && s.id === id ? { id, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { id, dir: 'asc' }))
  }
  const arrow = (id: string): string => (sort?.id === id ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '')
  const sortedIndicators = useMemo(() => {
    if (!sort) return doc.indicators
    const dir = sort.dir === 'asc' ? 1 : -1
    return [...doc.indicators].sort(
      (a, b) => sortValue(a, sort.id).localeCompare(sortValue(b, sort.id), undefined, { numeric: true, sensitivity: 'base' }) * dir
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sort, doc.indicators, results])

  // Build CSV (header row + one row per indicator, in current sort order) for the given rows.
  function buildCsv(targets: string[]): string {
    const cols = ['Indicator', 'Kind']
    for (const pid of providerIds) {
      const name = providerName(pid)
      cols.push(`${name} Status`)
      for (const f of fieldsByProvider[pid]) cols.push(`${name} ${f}`)
      cols.push(`${name} Source`)
    }
    const esc = (s: string): string => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
    const set = new Set(targets)
    const lines = [cols.map(esc).join(',')]
    for (const ind of sortedIndicators) {
      if (!set.has(ind.value)) continue
      const row = [ind.value, ind.kind]
      for (const pid of providerIds) {
        const r = results[ind.value]?.[pid]
        row.push(r?.status ?? '')
        for (const f of fieldsByProvider[pid]) row.push(r?.fields[f] ?? '')
        row.push(r ? (r.fromCache ? 'cached' : 'fresh') : '')
      }
      lines.push(row.map(esc).join(','))
    }
    return lines.join('\n')
  }
  // Copy the given rows as CSV to the clipboard.
  function copyAsCsv(targets: string[]): void {
    void navigator.clipboard.writeText(buildCsv(targets))
    setMenu(null)
  }
  // Export the ticked rows to a .csv file (confirmed in a dialog that shows the count).
  async function exportCsv(): Promise<void> {
    setExportOpen(false)
    await window.api.saveFile(buildCsv([...selected]), 'enrichment.csv')
  }

  return (
    <div
      className="flex flex-col flex-1 min-w-0 min-h-0 bg-citrus-cream/30 dark:bg-citrus-night"
      style={{ display: visible ? 'flex' : 'none' }}
    >
      {/* Intel DB bar — which database this tab reads/writes, + open/create/load-all. */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-1.5 border-b border-citrus-border dark:border-citrus-night-border">
        <span
          className="inline-flex items-center gap-1.5 text-[11px] text-citrus-dark dark:text-citrus-night-text"
          title={doc.dbPath || 'resolving…'}
        >
          <Database className="w-3.5 h-3.5 text-citrus-pink" />
          <span className="text-citrus-muted dark:text-citrus-night-muted">Intel DB:</span>
          <strong>{doc.name}</strong>
          {entryCount != null && (
            <span className="text-citrus-muted dark:text-citrus-night-muted">· {entryCount.toLocaleString()} entries</span>
          )}
        </span>
        <button
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold border border-citrus-border text-citrus-dark hover:bg-citrus-sand/60 transition-colors dark:border-citrus-night-border dark:text-citrus-night-text dark:hover:bg-citrus-night-elev"
          onClick={onOpenIntelDb}
          title="Open another intel DB in a new tab"
        >
          <FolderOpen className="w-3 h-3" /> Open…
        </button>
        <button
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold border border-citrus-border text-citrus-dark hover:bg-citrus-sand/60 transition-colors dark:border-citrus-night-border dark:text-citrus-night-text dark:hover:bg-citrus-night-elev"
          onClick={onNewIntelDb}
          title="Create a new intel DB in a new tab"
        >
          <FilePlus className="w-3 h-3" /> New…
        </button>
        <button
          className="ml-auto inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold border border-citrus-border text-citrus-dark hover:bg-citrus-sand/60 transition-colors disabled:opacity-40 dark:border-citrus-night-border dark:text-citrus-night-text dark:hover:bg-citrus-night-elev"
          onClick={loadAll}
          disabled={!doc.dbPath || entryCount === 0}
          title="Load every entry stored in this database into the table"
        >
          <ListTree className="w-3 h-3" /> Load all
        </button>
      </div>

      {/* Providers status strip */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-citrus-border dark:border-citrus-night-border">
        <span className="text-[10px] font-bold uppercase tracking-wide text-citrus-muted dark:text-citrus-night-muted">Providers</span>
        {providers.length === 0 && <span className="text-[11px] text-citrus-muted dark:text-citrus-night-muted">…</span>}
        {providers.map((p) => (
          <span
            key={p.id}
            className="inline-flex items-center gap-1.5 rounded-full border border-citrus-border px-2 py-0.5 text-[11px] dark:border-citrus-night-border"
            title={p.ready ? p.detail : `${p.name} needs configuring`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${p.ready ? 'bg-emerald-500' : 'bg-amber-500'}`} />
            <span className="font-semibold text-citrus-dark dark:text-citrus-night-text">{p.name}</span>
            <span className="text-citrus-muted dark:text-citrus-night-muted">· {p.ready ? p.detail : 'needs key'}</span>
            {p.ready && p.id === 'maxmind' && (
              <button
                className="ml-0.5 text-citrus-muted hover:text-citrus-pink disabled:opacity-50 dark:text-citrus-night-muted"
                onClick={() => void runSetup()}
                disabled={setupBusy}
                title="Update GeoLite2 data"
              >
                <RefreshCw className={`w-3 h-3 ${setupBusy ? 'animate-spin' : ''}`} />
              </button>
            )}
          </span>
        ))}
        <div className="ml-auto flex items-center gap-2">
          <button
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold border border-citrus-border text-citrus-dark hover:bg-citrus-sand/60 transition-colors dark:border-citrus-night-border dark:text-citrus-night-text dark:hover:bg-citrus-night-elev"
            onClick={() => setWatchlistsOpen(true)}
            title="Edit the curated context lists matched by the Watchlist provider"
          >
            <ListChecks className="w-3 h-3" /> Watchlists
          </button>
          <button
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold border border-citrus-border text-citrus-dark hover:bg-citrus-sand/60 transition-colors disabled:opacity-40 dark:border-citrus-night-border dark:text-citrus-night-text dark:hover:bg-citrus-night-elev"
            onClick={() => setExportOpen(true)}
            disabled={selected.size === 0}
            title={selected.size === 0 ? 'Tick rows to export' : `Export ${selected.size} ticked row(s) to CSV`}
          >
            <Download className="w-3 h-3" /> Export CSV
          </button>
          <button
            className={`px-2 py-0.5 rounded text-[11px] font-semibold border transition-colors ${
              wrap
                ? 'border-citrus-pink/40 text-citrus-pink bg-citrus-pink-light/60 dark:bg-citrus-night-elev'
                : 'border-citrus-border text-citrus-muted hover:text-citrus-pink dark:border-citrus-night-border dark:text-citrus-night-muted'
            }`}
            onClick={() => setWrap((w) => !w)}
            title="Wrap long values instead of truncating"
          >
            Wrap
          </button>
          <span className="text-[11px] font-mono text-citrus-muted dark:text-citrus-night-muted">
            {doc.indicators.length.toLocaleString()} indicators
          </span>
          {busy && (
            <button
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-bold border border-citrus-border text-citrus-muted hover:text-citrus-pink hover:border-citrus-pink/40 transition-colors dark:border-citrus-night-border dark:text-citrus-night-muted"
              onClick={cancel}
            >
              <X className="w-3 h-3" /> Cancel
            </button>
          )}
        </div>
      </div>

      {/* MaxMind setup card — shown until a database is installed. "Set it up for me" via a free key. */}
      {maxmind && !maxmind.ready && (
        <div className="mx-4 my-2 rounded-lg border border-citrus-border bg-citrus-card px-3 py-2.5 dark:border-citrus-night-border dark:bg-citrus-night-card">
          <div className="flex items-center gap-1.5 text-xs font-bold text-citrus-dark dark:text-citrus-night-text">
            <KeyRound className="w-3.5 h-3.5 text-citrus-pink" /> Set up GeoLite2 (free)
          </div>
          <p className="mt-1 text-[11px] text-citrus-muted dark:text-citrus-night-muted">
            MaxMind GeoLite2 is free but needs a one-time license key (their rule since 2019). Create a free
            account at <span className="font-mono">maxmind.com/geolite2/signup</span>, generate a license key,
            paste it below, and the app downloads + installs GeoLite2-City + ASN for you.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              type="password"
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
              placeholder={hasKey ? 'Key saved — leave blank to reuse' : 'Paste MaxMind license key'}
              className="w-60 px-2 py-1 text-xs rounded border border-citrus-border bg-citrus-cream text-citrus-dark outline-none focus:border-citrus-pink dark:border-citrus-night-border dark:bg-citrus-night dark:text-citrus-night-text"
            />
            <button
              className="inline-flex items-center gap-1 px-3 py-1 rounded-md text-[11px] font-bold bg-citrus-pink text-white hover:bg-citrus-pink-hover transition-colors disabled:opacity-40"
              onClick={() => void runSetup()}
              disabled={setupBusy || (!keyDraft.trim() && !hasKey)}
            >
              {setupBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
              Download GeoLite2 (City + ASN)
            </button>
            <button
              className="px-2 py-1 rounded text-[11px] font-semibold border border-citrus-border text-citrus-muted hover:text-citrus-pink hover:border-citrus-pink/40 transition-colors dark:border-citrus-night-border dark:text-citrus-night-muted"
              onClick={() => void pickDb()}
              title="Already have a .mmdb? Point at it instead."
            >
              Set .mmdb manually…
            </button>
          </div>
          {setupBusy && (
            <div className="mt-2 flex items-center gap-2 text-[11px] text-citrus-muted dark:text-citrus-night-muted">
              <div className="h-1 w-40 overflow-hidden rounded-full bg-citrus-sand dark:bg-citrus-night-elev">
                <div className="h-full rounded-full bg-citrus-pink transition-[width] duration-150" style={{ width: `${setup?.pct ?? 0}%` }} />
              </div>
              <span className="font-mono truncate">Downloading {setup?.editionId} · {setup?.pct ?? 0}%</span>
            </div>
          )}
          {setupErr && (
            <div className="mt-2 flex items-center gap-1.5 text-[11px] text-red-600 dark:text-red-400">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {setupErr}
            </div>
          )}
        </div>
      )}

      {/* Paste box — drag the bottom bar to resize; scrolls when full. Add only appends to the list. */}
      <div className="flex items-start gap-2 px-4 py-2 border-b border-citrus-border dark:border-citrus-night-border">
        <div className="flex-1 min-w-0 flex flex-col">
          <textarea
            className="pane__text w-full min-w-0 resize-none overflow-auto px-2 py-1 text-xs font-mono rounded-t border border-citrus-border bg-citrus-card text-citrus-dark outline-none focus:border-citrus-pink dark:border-citrus-night-border dark:bg-citrus-night-card dark:text-citrus-night-text"
            style={{ height: paneH }}
            placeholder="Paste IPs / domains / hashes (whitespace, comma, or newline separated), then Add. Ctrl+Enter to add."
            value={doc.draft}
            onChange={(e) => {
              onPatch({ draft: e.target.value })
              if (addNote) setAddNote(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                addFromDraft()
              }
            }}
          />
          <div
            onMouseDown={startResize}
            className="h-1.5 w-full cursor-row-resize rounded-b border-x border-b border-citrus-border bg-citrus-sand/50 hover:bg-citrus-pink/40 dark:border-citrus-night-border dark:bg-citrus-night-elev"
            title="Drag to resize"
          />
        </div>
        <button
          className="inline-flex items-center gap-1 px-2.5 py-1 mt-0.5 rounded-md text-[11px] font-bold bg-citrus-pink text-white hover:bg-citrus-pink-hover transition-colors disabled:opacity-40"
          onClick={addFromDraft}
          disabled={doc.draft.trim() === ''}
          title="Append these indicators to the list (select rows + right-click to look them up)"
        >
          <Plus className="w-3 h-3" /> Add
        </button>
        <button
          className="inline-flex items-center gap-1 px-2.5 py-1 mt-0.5 rounded-md text-[11px] font-bold border border-citrus-border text-citrus-muted hover:text-citrus-pink hover:border-citrus-pink/40 transition-colors disabled:opacity-40 dark:border-citrus-night-border dark:text-citrus-night-muted"
          onClick={clearAll}
          disabled={doc.indicators.length === 0 && doc.draft === ''}
        >
          <Trash2 className="w-3 h-3" /> Clear
        </button>
      </div>

      {/* Add summary (e.g. "added 3 · 1 already listed · 2 not recognized — kept in the box") */}
      {addNote && (
        <div className="px-4 py-1 text-[10px] text-citrus-muted dark:text-citrus-night-muted">{addNote}</div>
      )}

      {/* Progress */}
      {busy && progress && (
        <div className="flex items-center gap-2 px-4 py-1.5 text-[11px] text-citrus-muted dark:text-citrus-night-muted">
          <Loader2 className="w-3 h-3 animate-spin text-citrus-pink" />
          <div className="h-1 w-40 overflow-hidden rounded-full bg-citrus-sand dark:bg-citrus-night-elev">
            <div className="h-full rounded-full bg-citrus-pink transition-[width] duration-150" style={{ width: `${pct}%` }} />
          </div>
          <span className="font-mono truncate">
            {progress.done.toLocaleString()}/{progress.total.toLocaleString()} · {progress.current}
          </span>
        </div>
      )}

      {/* Hint */}
      {doc.indicators.length > 0 && (
        <div className="px-4 py-1 text-[10px] text-citrus-muted dark:text-citrus-night-muted">
          Click a row to highlight it; Shift+↑/↓ extends. Tick rows (or the header box to tick the highlighted ones), then right-click → Look up. Click a header to sort; hover a cell to copy it.
        </div>
      )}

      {/* Results matrix — one row per indicator, one column bucket per provider. Focusable so the
          arrow keys can move/extend the row highlight. */}
      <div
        ref={gridRef}
        tabIndex={0}
        onKeyDown={onGridKeyDown}
        className="pane__text--out flex-1 min-h-0 overflow-auto px-2 py-2 outline-none"
      >
        {doc.indicators.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-citrus-muted dark:text-citrus-night-muted">
            No indicators yet — paste some above, or use “Send to Intel” from a notepad or workspace.
          </div>
        ) : (
          <table className="text-xs border-collapse">
            <thead className="sticky top-0 z-10 bg-citrus-cream/90 backdrop-blur dark:bg-citrus-night/90">
              <tr className="text-left text-citrus-muted dark:text-citrus-night-muted">
                <th rowSpan={2} className="px-2 py-1 align-bottom">
                  <input
                    ref={headerBoxRef}
                    type="checkbox"
                    checked={allSelected}
                    onChange={onHeaderToggle}
                    title={
                      allSelected
                        ? 'Clear all ticks'
                        : highlighted.size > 0 && ![...highlighted].every((v) => selected.has(v))
                          ? 'Tick highlighted rows'
                          : 'Tick all rows'
                    }
                  />
                </th>
                <th rowSpan={2} className="px-2 py-1 text-right align-bottom font-semibold">#</th>
                <th
                  rowSpan={2}
                  className="px-2 py-1 font-semibold align-bottom cursor-pointer select-none hover:text-citrus-pink"
                  onClick={() => toggleSort('ind')}
                >
                  Indicator{arrow('ind')}
                </th>
                <th
                  rowSpan={2}
                  className="px-2 py-1 font-semibold align-bottom cursor-pointer select-none hover:text-citrus-pink"
                  onClick={() => toggleSort('kind')}
                >
                  Kind{arrow('kind')}
                </th>
                {providerIds.map((pid) => (
                  <th
                    key={pid}
                    colSpan={2 + fieldsByProvider[pid].length}
                    className="px-2 py-1 font-bold text-center text-citrus-pink border-l-[3px] border-citrus-pink/50 dark:border-citrus-pink/40"
                  >
                    {providerName(pid)}
                  </th>
                ))}
              </tr>
              <tr className="text-left text-citrus-muted dark:text-citrus-night-muted">
                {providerIds.map((pid) => (
                  <Fragment key={pid}>
                    <th
                      className="px-2 py-1 font-semibold border-l-[3px] border-citrus-pink/50 cursor-pointer select-none hover:text-citrus-pink dark:border-citrus-pink/40"
                      onClick={() => toggleSort(`p:${pid}:status`)}
                    >
                      Status{arrow(`p:${pid}:status`)}
                    </th>
                    {fieldsByProvider[pid].map((f) => (
                      <th
                        key={f}
                        className="px-2 py-1 font-semibold whitespace-nowrap cursor-pointer select-none hover:text-citrus-pink"
                        onClick={() => toggleSort(`p:${pid}:f:${f}`)}
                      >
                        {f}
                        {arrow(`p:${pid}:f:${f}`)}
                      </th>
                    ))}
                    <th
                      className="px-2 py-1 font-semibold cursor-pointer select-none hover:text-citrus-pink"
                      onClick={() => toggleSort(`p:${pid}:source`)}
                    >
                      Source{arrow(`p:${pid}:source`)}
                    </th>
                  </Fragment>
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedIndicators.map((ind, i) => {
                const isSel = selected.has(ind.value)
                const isHi = highlighted.has(ind.value)
                return (
                  <tr
                    key={`${ind.value}:${i}`}
                    className={`cursor-pointer select-none border-t border-citrus-border/60 dark:border-citrus-night-border/60 hover:bg-citrus-sand/30 dark:hover:bg-citrus-night-elev/40 ${
                      isHi
                        ? 'bg-citrus-pink-light/60 dark:bg-citrus-night-elev/80'
                        : isSel
                          ? 'bg-citrus-pink-light/20 dark:bg-citrus-night-elev/40'
                          : i % 2 === 1
                            ? 'bg-citrus-sand/15 dark:bg-citrus-night-card/30'
                            : ''
                    }`}
                    onMouseDown={(e) => {
                      if (e.button === 0) beginRow(i, ind.value)
                    }}
                    onMouseEnter={() => enterRow(i)}
                    onContextMenu={(e) => openMenu(e, ind.value)}
                  >
                    <td className="px-2 py-1">
                      <input
                        type="checkbox"
                        checked={isSel}
                        onMouseDown={(e) => e.stopPropagation()}
                        onChange={() => toggleRow(ind.value)}
                      />
                    </td>
                    <td className="px-2 py-1 text-right font-mono tabular-nums text-citrus-muted/70 dark:text-citrus-night-muted/70">
                      {i + 1}
                    </td>
                    <ValueCell text={ind.value} wrap={wrap} mono />
                    <td className="px-2 py-1 font-mono text-citrus-muted dark:text-citrus-night-muted">{ind.kind}</td>
                    {providerIds.map((pid) => {
                      const r = results[ind.value]?.[pid]
                      return (
                        <Fragment key={pid}>
                          <td className="px-2 py-1 border-l-[3px] border-citrus-pink/40 dark:border-citrus-pink/30 whitespace-nowrap">
                            {r ? (
                              <span className="inline-flex items-center gap-1.5">
                                <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${STATUS_STYLE[r.status] ?? ''}`} title={r.message}>
                                  {r.status}
                                </span>
                                {r.status !== 'ok' && r.message && (
                                  <span className="text-[10px] text-citrus-muted dark:text-citrus-night-muted">{r.message}</span>
                                )}
                              </span>
                            ) : (
                              <span className="text-citrus-muted/50 dark:text-citrus-night-muted/50">—</span>
                            )}
                          </td>
                          {fieldsByProvider[pid].map((f) =>
                            pid === 'watchlist' && f === 'Lists' ? (
                              <td key={f} className="px-2 py-1 align-top">
                                {r?.fields[f] ? (
                                  <span className="flex flex-wrap gap-1">
                                    {r.fields[f].split(', ').map((name) => (
                                      <span
                                        key={name}
                                        className="inline-block rounded-full bg-citrus-pink-light px-1.5 py-0.5 text-[10px] font-semibold text-citrus-pink dark:bg-citrus-night-elev"
                                      >
                                        {name}
                                      </span>
                                    ))}
                                  </span>
                                ) : (
                                  <span className="text-citrus-muted/40 dark:text-citrus-night-muted/40">—</span>
                                )}
                              </td>
                            ) : (
                              <ValueCell key={f} text={r?.fields[f] ?? ''} wrap={wrap} />
                            )
                          )}
                          <td
                            className="px-2 py-1 text-[10px] text-citrus-muted dark:text-citrus-night-muted whitespace-nowrap"
                            title={r?.fetchedAt ? `fetched ${new Date(r.fetchedAt).toLocaleString()}` : undefined}
                          >
                            {r ? (r.fromCache ? 'cached ✓' : 'fresh') : ''}
                          </td>
                        </Fragment>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Export-to-CSV confirmation (shows how many ticked rows will be exported). */}
      {exportOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm"
          onClick={() => setExportOpen(false)}
        >
          <div
            className="w-[22rem] max-w-[90vw] rounded-xl border border-citrus-border bg-citrus-card p-5 shadow-lg dark:border-citrus-night-border dark:bg-citrus-night-card"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-sm font-bold text-citrus-dark dark:text-citrus-night-text">Export to CSV</div>
            <p className="mt-2 text-xs text-citrus-muted dark:text-citrus-night-muted">
              Export <strong className="text-citrus-dark dark:text-citrus-night-text">{selected.size}</strong>{' '}
              {selected.size === 1 ? 'event' : 'events'} to a CSV file.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                className="px-3 py-1 rounded-md text-[11px] font-bold border border-citrus-border text-citrus-muted hover:text-citrus-pink hover:border-citrus-pink/40 transition-colors dark:border-citrus-night-border dark:text-citrus-night-muted"
                onClick={() => setExportOpen(false)}
              >
                Cancel
              </button>
              <button
                className="inline-flex items-center gap-1 px-3 py-1 rounded-md text-[11px] font-bold bg-citrus-pink text-white hover:bg-citrus-pink-hover transition-colors"
                onClick={() => void exportCsv()}
              >
                <Download className="w-3 h-3" /> Export
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Right-click menu: enrich the selected row(s) with a provider, or remove them. */}
      {menu && (
        <div
          className="enrich-context-menu fixed z-50 min-w-[200px] flex flex-col rounded-lg border border-citrus-border bg-citrus-card shadow-lg overflow-hidden dark:border-citrus-night-border dark:bg-citrus-night-card"
          style={{ top: Math.min(menu.y, window.innerHeight - 200), left: Math.min(menu.x, window.innerWidth - 220) }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="px-3 py-1.5 border-b border-citrus-border/60 text-[10px] font-bold uppercase tracking-wide text-citrus-muted dark:border-citrus-night-border/60 dark:text-citrus-night-muted">
            Look up {menu.targets.length} {menu.targets.length === 1 ? 'row' : 'rows'} with
          </div>
          {providers.map((p) => (
            <button
              key={p.id}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs text-citrus-dark hover:bg-citrus-pink-light/60 disabled:opacity-40 disabled:hover:bg-transparent dark:text-citrus-night-text dark:hover:bg-citrus-night-elev"
              disabled={!p.ready}
              title={p.ready ? '' : `${p.name} needs configuring`}
              onClick={() => enrichTargets(p.id, menu.targets)}
            >
              <Radar className="w-3.5 h-3.5 shrink-0 text-citrus-pink" />
              {p.name}
              {!p.ready && <span className="ml-auto text-[10px] text-citrus-muted dark:text-citrus-night-muted">needs config</span>}
            </button>
          ))}
          <button
            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs text-citrus-dark hover:bg-citrus-pink-light/60 border-t border-citrus-border/60 dark:text-citrus-night-text dark:hover:bg-citrus-night-elev dark:border-citrus-night-border/60"
            onClick={() => copyAsCsv(menu.targets)}
          >
            <Copy className="w-3.5 h-3.5 shrink-0 text-citrus-pink" />
            Copy as CSV
          </button>
          <button
            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs text-citrus-dark hover:bg-citrus-pink-light/60 dark:text-citrus-night-text dark:hover:bg-citrus-night-elev"
            onClick={() => clearCacheTargets(menu.targets)}
          >
            <Eraser className="w-3.5 h-3.5 shrink-0 text-citrus-muted dark:text-citrus-night-muted" />
            Clear cached results
          </button>
          <button
            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs text-citrus-dark hover:bg-citrus-pink-light/60 dark:text-citrus-night-text dark:hover:bg-citrus-night-elev"
            onClick={() => removeTargets(menu.targets)}
          >
            <Trash2 className="w-3.5 h-3.5 shrink-0 text-citrus-muted dark:text-citrus-night-muted" />
            Remove from list
          </button>
        </div>
      )}

      <WatchlistsPanel
        open={watchlistsOpen}
        onClose={() => setWatchlistsOpen(false)}
        onChanged={() => void window.api.enrich.providers().then(setProviders)}
      />
    </div>
  )
}
