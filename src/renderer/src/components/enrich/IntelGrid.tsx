import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  getGroupedRowModel,
  getExpandedRowModel,
  type ColumnDef,
  type FilterFn,
  type SortingState,
  type ColumnFiltersState,
  type RowSelectionState,
  type VisibilityState,
  type ColumnSizingState,
  type GroupingState,
  type ExpandedState
} from '@tanstack/react-table'
import { Check, ChevronDown, ChevronRight, Columns3, Copy, Crosshair, Download, Eraser, ExternalLink, Filter, Layers, MoreVertical, Radar, Search, Trash2, X } from 'lucide-react'
import type { EnrichItem, EnrichProviderInfo, EnrichResultRow } from '../../state/enrichTypes'

// The Intel results grid, built on TanStack Table (headless): TanStack owns the STATE + models —
// sorting (multi-column), per-column multi-select filters, the global (whole-row) search, faceted
// distinct values, row selection, column sizing + visibility — while we render the header/body
// ourselves so the provider-bucket layout, dividers, badges, and chips stay as designed. The dataset
// is the indicators the user added (small, in-memory) — no SQL; rows are virtualized (TanStack
// Virtual) only to keep the DOM light, not because the data is paged.
//
// Columns are fixed-width (TanStack columnSizing) so they're drag-resizable (double-click a handle
// to auto-fit). Widths, hidden columns, and sort persist to the doc (debounced), as does reorder.

type ResultMap = Record<string, Record<string, EnrichResultRow>>

const STATUS_STYLE: Record<string, string> = {
  ok: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  notfound: 'bg-citrus-sand text-citrus-muted dark:bg-citrus-night-elev dark:text-citrus-night-muted',
  error: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  skipped: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  private: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300'
}

/** Broad class of an indicator, used to section the grid. "Other" is deliberately a catch-all: a kind
 *  we can't enrich well yet still belongs in the list, it just doesn't need a taxonomy decision. */
export function indicatorClass(kind: string): 'Network' | 'File' | 'Other' {
  if (kind === 'ipv4' || kind === 'ipv6' || kind === 'domain' || kind === 'url') return 'Network'
  if (kind === 'md5' || kind === 'sha1' || kind === 'sha256') return 'File'
  return 'Other'
}

/** The field a provider grades an indicator with, if any — found by name rather than by provider id,
 *  so a new provider that emits a "… Verdict" field gets a verdict chip for free. A provider that
 *  doesn't grade anything (MaxMind geolocates; Watchlist reports membership, and can't even fail)
 *  has no verdict, and therefore gets no Status column at all. */
export function verdictFieldOf(fields: string[]): string | undefined {
  return fields.find((f) => /verdict$/i.test(f))
}

// Verdict colors (red/amber/green) + the grey "Unknown" for a 404 (no record ≠ clean).
const VT_VERDICT_STYLE: Record<string, string> = {
  Malicious: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  Suspicious: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  Clean: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  Unknown: 'bg-citrus-sand text-citrus-muted dark:bg-citrus-night-elev dark:text-citrus-night-muted'
}

/** The Status cell, shown ONLY for a provider that actually grades an indicator. A colored verdict
 *  chip + an N/total detections count when the fields carry them; 404 → grey "Unknown" (no record is
 *  not the same as clean). A failed lookup falls back to the raw status + its message. */
function StatusCell({ verdictField, r }: { verdictField: string; r: EnrichResultRow }): JSX.Element {
  if (r.status === 'ok') {
    const verdict = r.fields[verdictField] || 'Clean'
    const mal = r.fields['VT Malicious']
    const total = r.fields['VT Total']
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${VT_VERDICT_STYLE[verdict] ?? ''}`}>{verdict}</span>
        {mal !== undefined && total !== undefined && (
          <span className="text-[10px] text-citrus-muted dark:text-citrus-night-muted">
            {mal}/{total}
          </span>
        )}
      </span>
    )
  }
  if (r.status === 'notfound') {
    return (
      <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${VT_VERDICT_STYLE.Unknown}`} title={r.message}>
        Unknown
      </span>
    )
  }
  return <ProblemChip r={r} />
}

/** A non-ok result for a provider with no Status column of its own. Those providers' fields go blank
 *  on a failure, so without this a private IP or an unconfigured database would render as an
 *  unexplained empty row. Shown in the bucket's first field cell. */
function ProblemChip({ r }: { r: EnrichResultRow }): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${STATUS_STYLE[r.status] ?? ''}`} title={r.message}>
        {r.status}
      </span>
      {r.message && <span className="text-[10px] text-citrus-muted dark:text-citrus-night-muted">{r.message}</span>}
    </span>
  )
}

/** "today" / "Nd ago" from an epoch-ms timestamp — VirusTotal verdicts never auto-expire, so the grid
 *  surfaces how stale a cached row is. */
function agoLabel(ts: number): string {
  const days = Math.floor((Date.now() - ts) / 86_400_000)
  return days <= 0 ? 'today' : days === 1 ? '1d ago' : `${days}d ago`
}

const SELECT_W = 34
const NUM_W = 44
const MIN_W = 56
const MAX_AUTOFIT_W = 600

/** Pixel width of `text` rendered at the grid's cell font (mono for the identity columns). Used by
 *  double-click auto-fit; the dataset is in memory, so no SQL round-trip is needed. */
function measureWidth(text: string, mono: boolean): number {
  const el = document.createElement('span')
  el.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;pointer-events:none'
  el.className = `text-xs ${mono ? 'font-mono' : ''}`
  el.textContent = text
  document.body.appendChild(el)
  const w = el.offsetWidth
  document.body.removeChild(el)
  return w
}
function defaultSize(ckind: Leaf['ckind']): number {
  switch (ckind) {
    case 'indicator':
      return 190
    case 'kind':
      return 70
    case 'status':
      return 104
    case 'source':
      return 74
    default:
      return 150
  }
}

const FIELD_ORDER = [
  // VirusTotal headline (verdict + counts lead the bucket)
  'VT Verdict', 'VT Malicious', 'VT Suspicious', 'VT Total', 'Reputation',
  // Geo / network (shared by MaxMind + VirusTotal)
  'Country', 'Region', 'City', 'Continent', 'Lat/Lon', 'ASN', 'AS Owner', 'Org', 'Network',
  // Domain
  'Registrar', 'Categories', 'Created',
  // File
  'Name', 'Type', 'Size',
  // External link last
  'VT Link'
]
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
function orderByList(keys: string[], order: string[]): string[] {
  const known = order.filter((k) => keys.includes(k))
  const rest = keys.filter((k) => !order.includes(k))
  return [...known, ...rest]
}

interface Leaf {
  colId: string
  label: string
  pid?: string
  ckind: 'indicator' | 'kind' | 'status' | 'source' | 'field'
  field?: string
  firstInBucket?: boolean
}
interface IntelRow {
  value: string
  kind: string
  /** Broad class (Network / File / Other) — the grid's default section grouping. */
  cls: string
  cells: Record<string, string>
  byP: Record<string, EnrichResultRow>
  hay: string
}

/** A value cell with a hover "copy" button. Fixed-width: truncates (ellipsis) unless `wrap`. */
function ValueCell({ text, wrap, mono, style, className }: {
  text: string
  wrap: boolean
  mono?: boolean
  style?: React.CSSProperties
  className?: string
}): JSX.Element {
  const [done, setDone] = useState(false)
  return (
    <td
      style={style}
      className={`relative group px-2 py-1 overflow-hidden ${wrap ? 'whitespace-normal break-words' : 'whitespace-nowrap text-ellipsis'} ${
        mono ? 'font-mono' : ''
      } text-citrus-dark dark:text-citrus-night-text ${className ?? ''}`}
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

// A column's 3-dots dropdown: distinct values (faceted, with counts) as a multi-select checklist.
function ColMenu({ label, distinct, current, grouped, x, y, onApply, onToggleGroup, onClose }: {
  label: string
  distinct: Array<{ value: string; count: number }>
  current: string[]
  grouped: boolean
  x: number
  y: number
  onApply: (values: string[]) => void
  onToggleGroup: () => void
  onClose: () => void
}): JSX.Element {
  const allVals = useMemo(() => distinct.map((d) => d.value), [distinct])
  const [picked, setPicked] = useState<Set<string>>(() => (current.length ? new Set(current) : new Set(allVals)))
  const [needle, setNeedle] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])
  const shown = useMemo(() => {
    const n = needle.trim().toLowerCase()
    return n === '' ? distinct : distinct.filter((d) => d.value.toLowerCase().includes(n))
  }, [distinct, needle])
  function toggle(v: string): void {
    setPicked((p) => {
      const n = new Set(p)
      if (n.has(v)) n.delete(v)
      else n.add(v)
      return n
    })
  }
  const W = 256
  const left = Math.min(x, window.innerWidth - W - 8)
  return (
    <div
      ref={ref}
      className="intel-colmenu fixed z-50 flex flex-col rounded-lg border border-citrus-border bg-citrus-card shadow-lg overflow-hidden dark:border-citrus-night-border dark:bg-citrus-night-card"
      style={{ top: y + 4, left, width: W }}
    >
      <div className="flex items-center gap-1 px-3 py-1.5 border-b border-citrus-border/60 text-[10px] font-bold uppercase tracking-wide text-citrus-muted dark:border-citrus-night-border/60 dark:text-citrus-night-muted">
        <span className="truncate">{label}</span>
        <span className="ml-auto font-normal normal-case tracking-normal">{distinct.length} distinct</span>
      </div>
      <button
        onClick={() => { onToggleGroup(); onClose() }}
        className="flex items-center gap-2 px-3 py-1.5 text-left text-xs text-citrus-dark hover:bg-citrus-pink-light/60 border-b border-citrus-border/60 dark:text-citrus-night-text dark:hover:bg-citrus-night-elev dark:border-citrus-night-border/60"
      >
        <Layers className="w-3.5 h-3.5 shrink-0 text-citrus-pink" />
        {grouped ? 'Remove grouping' : 'Group by this column'}
      </button>
      <input
        autoFocus
        value={needle}
        onChange={(e) => setNeedle(e.target.value)}
        placeholder="find a value…"
        className="mx-2 my-1.5 px-2 py-1 text-[11px] rounded border border-citrus-border bg-citrus-cream text-citrus-dark outline-none focus:border-citrus-pink dark:border-citrus-night-border dark:bg-citrus-night dark:text-citrus-night-text"
      />
      <div className="max-h-56 overflow-auto scrollbar-none">
        {shown.map((d) => {
          const on = picked.has(d.value)
          return (
            <button
              key={d.value}
              className="w-full flex items-center gap-2 px-3 py-1 text-left text-[11px] font-mono hover:bg-citrus-pink-light/50 dark:hover:bg-citrus-night-elev"
              onClick={() => toggle(d.value)}
            >
              <span
                className={`shrink-0 w-3.5 h-3.5 rounded-sm border flex items-center justify-center ${
                  on ? 'bg-citrus-pink border-citrus-pink text-white' : 'border-citrus-border dark:border-citrus-night-border'
                }`}
              >
                {on && <Check className="w-2.5 h-2.5" />}
              </span>
              <span className="truncate flex-1 text-citrus-dark dark:text-citrus-night-text">{d.value === '' ? '∅ (empty)' : d.value}</span>
              <span className="shrink-0 text-citrus-muted dark:text-citrus-night-muted">{d.count.toLocaleString()}</span>
            </button>
          )
        })}
        {shown.length === 0 && <div className="px-3 py-2 text-[11px] text-citrus-muted dark:text-citrus-night-muted">no values</div>}
      </div>
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-t border-citrus-border/60 dark:border-citrus-night-border/60">
        <button
          className="flex-1 px-2 py-1 rounded-md text-[11px] font-bold bg-citrus-pink text-white hover:bg-citrus-pink-hover"
          onClick={() => {
            onApply(picked.size === allVals.length ? [] : [...picked])
            onClose()
          }}
          title="Show only the checked value(s)"
        >
          Apply{picked.size > 0 && picked.size < allVals.length ? ` (${picked.size})` : ''}
        </button>
        <button className="px-2 py-1 rounded-md text-[11px] font-bold text-citrus-muted hover:text-citrus-pink dark:text-citrus-night-muted" onClick={() => setPicked(new Set(allVals))} title="Select all">
          All
        </button>
        <button className="px-2 py-1 rounded-md text-[11px] font-bold text-citrus-muted hover:text-citrus-pink dark:text-citrus-night-muted" onClick={() => setPicked(new Set())} title="Clear selection">
          None
        </button>
      </div>
    </div>
  )
}

const csvEsc = (s: string): string => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)

export function IntelGrid({
  indicators,
  results,
  providers,
  providerOrder,
  fieldOrder,
  savedSizing,
  savedVisibility,
  savedSorting,
  onReorder,
  onViewState,
  onRun,
  onClearCache,
  onRemove,
  onSweep
}: {
  indicators: EnrichItem[]
  results: ResultMap
  providers: EnrichProviderInfo[]
  providerOrder?: string[]
  fieldOrder?: Record<string, string[]>
  /** Persisted view state to restore on mount (widths / hidden columns / sort). */
  savedSizing?: ColumnSizingState
  savedVisibility?: VisibilityState
  savedSorting?: SortingState
  onReorder: (patch: { providerOrder?: string[]; fieldOrder?: Record<string, string[]> }) => void
  /** Persist view state back to the doc (debounced; widths survive a reload now). */
  onViewState: (patch: { colSizing?: ColumnSizingState; colVisibility?: VisibilityState; sorting?: SortingState }) => void
  onRun: (providerId: string, values: string[]) => void
  onClearCache: (values: string[]) => void
  onRemove: (values: string[]) => void
  /** Pivot: sweep a workspace source for the selected indicators (target chosen upstream). */
  onSweep: (values: string[]) => void
}): JSX.Element {
  const providerName = (pid: string): string => providers.find((p) => p.id === pid)?.name ?? pid

  const providerIds = useMemo(() => {
    const seen: string[] = []
    for (const ind of indicators) {
      const byP = results[ind.value]
      if (byP) for (const pid of Object.keys(byP)) if (!seen.includes(pid)) seen.push(pid)
    }
    return providerOrder ? orderByList(seen, providerOrder) : seen
  }, [indicators, results, providerOrder])

  const fieldsByProvider = useMemo(() => {
    const m: Record<string, string[]> = {}
    for (const ind of indicators) {
      const byP = results[ind.value]
      if (!byP) continue
      for (const pid of Object.keys(byP)) {
        const arr = m[pid] ?? (m[pid] = [])
        for (const k of Object.keys(byP[pid].fields)) if (!arr.includes(k)) arr.push(k)
      }
    }
    for (const pid of Object.keys(m)) {
      const custom = fieldOrder?.[pid]
      m[pid] = custom ? orderByList(m[pid], custom) : orderFields(m[pid])
    }
    return m
  }, [indicators, results, fieldOrder])

  const leaves = useMemo<Leaf[]>(() => {
    const out: Leaf[] = [
      { colId: 'value', label: 'Indicator', ckind: 'indicator' },
      { colId: 'kind', label: 'Kind', ckind: 'kind' }
    ]
    for (const pid of providerIds) {
      const name = providerName(pid)
      const all = fieldsByProvider[pid]
      const vf = verdictFieldOf(all)
      // Only a provider that grades gets a Status column; the others would just say "ok" forever.
      let first = true
      if (vf) {
        out.push({ colId: `p:${pid}:status`, label: `${name} Status`, pid, ckind: 'status', firstInBucket: true })
        first = false
      }
      for (const f of all) {
        // The verdict IS the Status chip — don't also render it as a redundant text column.
        if (f === vf) continue
        out.push({ colId: `p:${pid}:f:${f}`, label: `${name} ${f}`, pid, ckind: 'field', field: f, firstInBucket: first })
        first = false
      }
      out.push({ colId: `p:${pid}:source`, label: `${name} Checked`, pid, ckind: 'source' })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerIds, fieldsByProvider, providers])

  const data = useMemo<IntelRow[]>(() => {
    return indicators.map((ind) => {
      const byP = results[ind.value] ?? {}
      const cells: Record<string, string> = { value: ind.value, kind: ind.kind }
      let hay = `${ind.value} ${ind.kind}`
      for (const pid of Object.keys(byP)) {
        const r = byP[pid]
        cells[`p:${pid}:status`] = r.status
        cells[`p:${pid}:source`] = r.fetchedAt ? agoLabel(r.fetchedAt) : ''
        hay += ` ${r.status} ${r.message ?? ''}`
        for (const f of Object.keys(r.fields)) {
          cells[`p:${pid}:f:${f}`] = r.fields[f]
          hay += ` ${r.fields[f]}`
        }
      }
      return { value: ind.value, kind: ind.kind, cls: indicatorClass(ind.kind), cells, byP, hay: hay.toLowerCase() }
    })
  }, [indicators, results])

  const inSet: FilterFn<IntelRow> = (row, colId, value) => {
    const vals = value as string[] | undefined
    return !vals?.length || vals.includes(String(row.getValue(colId) ?? ''))
  }

  const columns = useMemo<ColumnDef<IntelRow>[]>(() => {
    const cols: ColumnDef<IntelRow>[] = leaves.map((l) => ({
      id: l.colId,
      accessorFn: (r) => r.cells[l.colId] ?? '',
      filterFn: inSet,
      sortingFn: 'alphanumeric',
      enableGlobalFilter: false,
      size: defaultSize(l.ckind),
      minSize: MIN_W
    }))
    // Grouping-only: sections the grid by indicator class. Never rendered as a column of its own —
    // the group header already says "Class: Network", so a column repeating it on every row is noise.
    cols.push({ id: 'class', accessorFn: (r) => r.cls, enableGlobalFilter: false, enableSorting: false, enableGrouping: true })
    cols.push({ id: '__search', accessorFn: (r) => r.hay, enableGlobalFilter: true, enableSorting: false, enableGrouping: false })
    return cols
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leaves])

  // Widths / hidden columns / sort restore from the doc on mount, then live in local state (so a
  // resize drag stays smooth); the effect below mirrors changes back to the doc, debounced.
  const [sorting, setSorting] = useState<SortingState>(() => savedSorting ?? [])
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const [globalFilter, setGlobalFilter] = useState('')
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({})
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(() => savedVisibility ?? {})
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>(() => savedSizing ?? {})
  // Sectioned by indicator class out of the box, so IPs and file hashes never sit in one flat list.
  const [grouping, setGrouping] = useState<GroupingState>(['class'])
  // Sections are grouped by default, so they must also be OPEN by default — a collapsed-by-default
  // grid greets you with nothing but two section headers.
  const [expanded, setExpanded] = useState<ExpandedState>(true)

  // Persist view state to the doc whenever it changes, debounced so a resize drag writes once on
  // settle (not per mousemove). The ref keeps the callback fresh without retriggering the effect,
  // and the mount guard avoids echoing the just-loaded state straight back.
  const onViewStateRef = useRef(onViewState)
  onViewStateRef.current = onViewState
  const persistedOnce = useRef(false)
  useEffect(() => {
    if (!persistedOnce.current) {
      persistedOnce.current = true
      return
    }
    const t = window.setTimeout(
      () => onViewStateRef.current({ colSizing: columnSizing, colVisibility: columnVisibility, sorting }),
      250
    )
    return () => window.clearTimeout(t)
  }, [columnSizing, columnVisibility, sorting])

  const table = useReactTable({
    data,
    columns,
    state: { sorting, columnFilters, globalFilter, rowSelection, columnVisibility, columnSizing, grouping, expanded },
    getRowId: (r) => r.value,
    filterFns: { inSet },
    globalFilterFn: 'includesString',
    enableMultiSort: true,
    // Results stream in after mount, and every data change would otherwise auto-reset `expanded`
    // back to {} — collapsing the sections the moment the first lookup lands.
    autoResetExpanded: false,
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    onRowSelectionChange: setRowSelection,
    onColumnVisibilityChange: setColumnVisibility,
    onColumnSizingChange: setColumnSizing,
    onGroupingChange: setGrouping,
    onExpandedChange: setExpanded,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getGroupedRowModel: getGroupedRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues()
  })

  const rows = table.getRowModel().rows
  const visibleValues = useMemo(() => rows.map((r) => r.original?.value ?? ''), [rows])
  const labelFor = (colId: string): string => (colId === 'class' ? 'Class' : (leaves.find((l) => l.colId === colId)?.label ?? colId))
  const widthOf = (colId: string): number => table.getColumn(colId)?.getSize() ?? 150
  const isVis = (colId: string): boolean => table.getColumn(colId)?.getIsVisible() ?? true

  // Visible bucket structure (honors column visibility): which buckets + leaves to render.
  const visBuckets = useMemo(() => {
    return providerIds
      .map((pid) => {
        const all = fieldsByProvider[pid]
        // No verdict → no Status column at all (isVis() defaults true for a column that doesn't
        // exist, so the verdict check has to gate this, not visibility alone).
        const verdictField = verdictFieldOf(all)
        const showStatus = !!verdictField && isVis(`p:${pid}:status`)
        const showSource = isVis(`p:${pid}:source`)
        const fields = all.filter((f) => f !== verdictField && isVis(`p:${pid}:f:${f}`))
        const count = (showStatus ? 1 : 0) + fields.length + (showSource ? 1 : 0)
        return { pid, name: providerName(pid), showStatus, showSource, fields, count, verdictField }
      })
      .filter((b) => b.count > 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerIds, fieldsByProvider, columnVisibility, providers])

  const totalWidth = useMemo(() => {
    let w = SELECT_W + NUM_W
    if (isVis('value')) w += widthOf('value')
    if (isVis('kind')) w += widthOf('kind')
    for (const b of visBuckets) {
      if (b.showStatus) w += widthOf(`p:${b.pid}:status`)
      for (const f of b.fields) w += widthOf(`p:${b.pid}:f:${f}`)
      if (b.showSource) w += widthOf(`p:${b.pid}:source`)
    }
    return w
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visBuckets, columnSizing, columnVisibility])

  // --- column menu (distinct/filter) ---
  const [colMenu, setColMenu] = useState<{ colId: string; x: number; y: number } | null>(null)
  const distinctFor = (colId: string): Array<{ value: string; count: number }> => {
    const m = table.getColumn(colId)?.getFacetedUniqueValues()
    if (!m) return []
    return [...m.entries()]
      .map(([value, count]) => ({ value: String(value ?? ''), count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, undefined, { numeric: true }))
  }

  // --- column resize (drag a header's right edge) ---
  function startResize(e: React.MouseEvent, colId: string): void {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startW = widthOf(colId)
    const onMove = (ev: MouseEvent): void => setColumnSizing((s) => ({ ...s, [colId]: Math.max(MIN_W, startW + (ev.clientX - startX)) }))
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }
  // Double-click the handle → fit the column to its widest value (whole in-memory dataset) + header.
  // Scanning by string length first keeps this to two DOM measures regardless of row count.
  function autoFit(colId: string): void {
    const leaf = leaves.find((l) => l.colId === colId)
    const header = !leaf
      ? colId
      : leaf.ckind === 'status'
        ? 'Status'
        : leaf.ckind === 'source'
          ? 'Source'
          : leaf.ckind === 'field'
            ? leaf.field ?? ''
            : leaf.label
    const mono = colId === 'value' || colId === 'kind'
    let longest = ''
    for (const r of data) {
      const v = r.cells[colId]
      if (v && v.length > longest.length) longest = v
    }
    const cellW = longest ? measureWidth(longest, mono) + 20 : 0 // px-2 padding + buffer
    const headerW = measureWidth(header, false) + 44 // padding + sort badge + 3-dots
    const w = Math.min(MAX_AUTOFIT_W, Math.max(MIN_W, Math.ceil(Math.max(cellW, headerW))))
    setColumnSizing((s) => ({ ...s, [colId]: w }))
  }
  function resizeHandle(colId: string): JSX.Element {
    return (
      <span
        onMouseDown={(e) => startResize(e, colId)}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => {
          e.stopPropagation()
          autoFit(colId)
        }}
        className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-citrus-pink/40"
        title="Drag to resize · double-click to fit"
      />
    )
  }

  // --- selection (single model, via TanStack rowSelection): click=select, shift=range, ctrl=toggle ---
  const selectedValues = useMemo(() => Object.keys(rowSelection).filter((k) => rowSelection[k]), [rowSelection])
  const anchorRef = useRef(-1)
  // The moving end of a keyboard range-select (Shift+Arrow). Distinct from the anchor so each press
  // extends the span by one instead of re-selecting just the anchor's neighbour.
  const focusRef = useRef(-1)
  const dragRef = useRef(false)
  const gridRef = useRef<HTMLDivElement>(null)
  const headerBoxRef = useRef<HTMLInputElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  // Row virtualization: only the on-screen rows of the (already filtered/sorted/grouped) row model
  // are mounted. The virtualizer operates over `rows` — the OUTPUT of TanStack's models — so it
  // never touches filtering, faceted distinct values, search, or grouping; it only decides which of
  // the resulting rows get DOM nodes. Heights are measured per-row (`measureElement`) because the
  // Wrap toggle makes rows multi-line, so we can't assume a fixed height.
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => gridRef.current,
    estimateSize: () => 29,
    overscan: 16,
    // Re-key measurement when Wrap flips (cached heights are stale once rows can grow/shrink).
    getItemKey: (index) => rows[index]?.id ?? index
  })
  const virtualRows = rowVirtualizer.getVirtualItems()
  const padTop = virtualRows.length ? virtualRows[0].start : 0
  const padBottom = virtualRows.length ? rowVirtualizer.getTotalSize() - virtualRows[virtualRows.length - 1].end : 0
  useEffect(() => {
    if (headerBoxRef.current) headerBoxRef.current.indeterminate = table.getIsSomeRowsSelected() && !table.getIsAllRowsSelected()
  }, [rowSelection, table])
  useEffect(() => {
    const onUp = (): void => {
      dragRef.current = false
    }
    window.addEventListener('mouseup', onUp)
    return () => window.removeEventListener('mouseup', onUp)
  }, [])
  function selectRange(a: number, b: number): void {
    const lo = Math.min(a, b)
    const hi = Math.max(a, b)
    const next: RowSelectionState = {}
    for (let i = lo; i <= hi; i++) if (visibleValues[i] != null) next[visibleValues[i]] = true
    setRowSelection(next)
  }
  function rowMouseDown(e: React.MouseEvent, index: number, value: string): void {
    if (e.button !== 0) return
    gridRef.current?.focus()
    if (e.shiftKey && anchorRef.current >= 0) {
      selectRange(anchorRef.current, index)
      focusRef.current = index
      return
    }
    if (e.ctrlKey || e.metaKey) {
      setRowSelection((prev) => ({ ...prev, [value]: !prev[value] }))
      anchorRef.current = index
      focusRef.current = index
      return
    }
    setRowSelection({ [value]: true })
    anchorRef.current = index
    focusRef.current = index
    dragRef.current = true
  }
  function rowMouseEnter(index: number): void {
    if (!dragRef.current || anchorRef.current < 0) return
    selectRange(anchorRef.current, index)
    focusRef.current = index
  }
  function onGridKeyDown(e: React.KeyboardEvent): void {
    const mod = e.ctrlKey || e.metaKey
    // Ctrl/Cmd+A — select every (filtered) row.
    if (mod && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault()
      const next: RowSelectionState = {}
      for (const v of visibleValues) next[v] = true
      setRowSelection(next)
      anchorRef.current = 0
      focusRef.current = visibleValues.length - 1
      return
    }
    // Ctrl/Cmd+C — copy selected rows as CSV; Ctrl/Cmd+Shift+C — copy just the indicator values.
    if (mod && (e.key === 'c' || e.key === 'C')) {
      if (selectedValues.length === 0) return
      if (e.shiftKey) {
        e.preventDefault()
        void navigator.clipboard.writeText(selectedIndicators(selectedValues))
        return
      }
      // Plain Ctrl+C copies whole rows — unless text is highlighted in a cell (let the native copy win).
      if ((window.getSelection()?.toString() ?? '') !== '') return
      e.preventDefault()
      void navigator.clipboard.writeText(buildCsv(selectedValues))
      return
    }
    // Ctrl/Cmd+F — jump to the search box.
    if (mod && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault()
      searchRef.current?.focus()
      searchRef.current?.select()
      return
    }
    if (e.key === 'Escape' && selectedValues.length > 0) {
      setRowSelection({})
      return
    }
    // Delete / Backspace — remove the selected indicators from the list (cache untouched).
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedValues.length > 0) {
      e.preventDefault()
      onRemove(selectedValues)
      setRowSelection({})
      return
    }
    if ((e.key !== 'ArrowDown' && e.key !== 'ArrowUp') || visibleValues.length === 0) return
    e.preventDefault()
    const delta = e.key === 'ArrowDown' ? 1 : -1
    let focus: number
    if (e.shiftKey && anchorRef.current >= 0) {
      // Extend: advance the FOCUS end by one, keep the anchor fixed, select the whole span.
      const from = focusRef.current >= 0 ? focusRef.current : anchorRef.current
      focus = Math.min(visibleValues.length - 1, Math.max(0, from + delta))
      focusRef.current = focus
      selectRange(anchorRef.current, focus)
    } else {
      // Move: single-select the next row; anchor + focus both jump to it.
      focus = anchorRef.current < 0 ? 0 : Math.min(visibleValues.length - 1, Math.max(0, anchorRef.current + delta))
      setRowSelection({ [visibleValues[focus]]: true })
      anchorRef.current = focus
      focusRef.current = focus
    }
    rowVirtualizer.scrollToIndex(focus) // keep the moving row on-screen when virtualized
  }

  // --- right-click context menu ---
  const [menu, setMenu] = useState<{ x: number; y: number; targets: string[] } | null>(null)
  function openMenu(e: React.MouseEvent, value: string): void {
    e.preventDefault()
    let targets: string[]
    if (rowSelection[value] && selectedValues.length > 0) targets = selectedValues
    else {
      targets = [value]
      setRowSelection({ [value]: true })
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

  // --- CSV build (copy + export), in current display order over a set of values ---
  function buildCsv(values: string[]): string {
    const set = new Set(values)
    const cols = leaves.filter((l) => isVis(l.colId))
    const lines = [cols.map((l) => csvEsc(l.label)).join(',')]
    // Iterate the flat data (grouping-independent) so collapsed-group rows still export.
    for (const r of data) {
      if (!set.has(r.value)) continue
      lines.push(cols.map((l) => csvEsc(r.cells[l.colId] ?? '')).join(','))
    }
    return lines.join('\n')
  }
  // Just the indicator values for a set, in display order (the "copy indicator only" action).
  function selectedIndicators(values: string[]): string {
    const set = new Set(values)
    return data.filter((r) => set.has(r.value)).map((r) => r.value).join('\n')
  }
  const [exportOpen, setExportOpen] = useState(false)
  async function exportCsv(): Promise<void> {
    setExportOpen(false)
    await window.api.saveFile(buildCsv(selectedValues), 'intel.csv')
  }

  // --- column reorder (drag bucket / field headers); persisted via onReorder(doc order) ---
  const [dragP, setDragP] = useState<string | null>(null)
  const [dragF, setDragF] = useState<{ pid: string; f: string } | null>(null)
  // Live drop indicator: which header is hovered + which edge the dragged column will land on.
  const [dropAt, setDropAt] = useState<{ colId: string; side: 'before' | 'after' } | null>(null)

  // Which half of the hovered header the cursor is in → insert before (left half) or after (right).
  function dropSide(e: React.DragEvent): 'before' | 'after' {
    const r = e.currentTarget.getBoundingClientRect()
    return e.clientX < r.left + r.width / 2 ? 'before' : 'after'
  }
  // Move `from` to sit before/after `to`. Symmetric in both drag directions — a plain insert-before
  // no-ops when you drop a column on its immediate right neighbour (the old reorder bug).
  function moveBeside<T>(arr: T[], from: T, to: T, side: 'before' | 'after'): T[] {
    const next = arr.filter((x) => x !== from)
    let idx = next.indexOf(to)
    if (idx < 0) idx = next.length
    if (side === 'after') idx += 1
    next.splice(idx, 0, from)
    return next
  }
  function reorderProviders(from: string, to: string, side: 'before' | 'after'): void {
    if (from === to) return
    onReorder({ providerOrder: moveBeside(providerIds, from, to, side) })
  }
  function reorderFields(pid: string, from: string, to: string, side: 'before' | 'after'): void {
    if (from === to) return
    onReorder({ fieldOrder: { ...(fieldOrder ?? {}), [pid]: moveBeside(fieldsByProvider[pid], from, to, side) } })
  }
  // The pink insertion line drawn on a header's left/right edge while it's the active drop target.
  function dropLine(colId: string): JSX.Element | null {
    if (dropAt?.colId !== colId) return null
    return (
      <span
        className={`pointer-events-none absolute top-0 bottom-0 z-20 w-[3px] bg-citrus-pink ${dropAt.side === 'before' ? 'left-0' : 'right-0'}`}
      />
    )
  }

  const [wrap, setWrap] = useState(false)
  const [colsOpen, setColsOpen] = useState(false)

  // Wrap changes every row's height, so the virtualizer's cached measurements are stale — reset
  // them and re-measure on the next paint.
  useEffect(() => {
    rowVirtualizer.measure()
  }, [wrap, rowVirtualizer])

  function colDots(colId: string): JSX.Element {
    const active = !!table.getColumn(colId)?.getFilterValue()
    return (
      <button
        onClick={(e) => {
          e.stopPropagation()
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
          setColMenu({ colId, x: r.left, y: r.bottom })
        }}
        onMouseDown={(e) => e.stopPropagation()}
        title="Distinct values · filter"
        className={`ml-1 align-middle ${active ? 'text-citrus-pink' : 'text-citrus-muted/40 hover:text-citrus-pink'}`}
      >
        <MoreVertical className="inline w-3 h-3" />
      </button>
    )
  }
  function sortBadge(colId: string): JSX.Element | null {
    const col = table.getColumn(colId)
    const d = col?.getIsSorted()
    if (!d) return null
    const idx = col!.getSortIndex()
    return (
      <span className="ml-0.5 text-citrus-pink">
        {d === 'asc' ? '▲' : '▼'}
        {sorting.length > 1 && idx >= 0 && <sup className="text-[8px]">{idx + 1}</sup>}
      </span>
    )
  }
  const headTh = 'relative px-2 py-1 font-semibold select-none align-bottom'
  // A leaf header cell: click to sort (shift = multi), 3-dots to filter, draggable (fields) to reorder.
  function leafHeader(l: Leaf): JSX.Element {
    const div = l.firstInBucket ? 'border-l-[3px] border-citrus-pink/50 dark:border-citrus-pink/40' : ''
    const drag = l.ckind === 'field' && l.pid
    const w = widthOf(l.colId)
    return (
      <th
        key={l.colId}
        style={{ width: w, minWidth: w, maxWidth: w }}
        draggable={!!drag}
        onDragStart={drag ? (e) => { setDragF({ pid: l.pid!, f: l.field! }); e.dataTransfer.effectAllowed = 'move' } : undefined}
        onDragOver={
          drag
            ? (e) => {
                // Only fields of the SAME bucket are valid drop targets (no cross-provider moves).
                if (!dragF || dragF.pid !== l.pid || dragF.f === l.field) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                const side = dropSide(e)
                setDropAt((d) => (d?.colId === l.colId && d.side === side ? d : { colId: l.colId, side }))
              }
            : undefined
        }
        onDrop={
          drag
            ? (e) => {
                e.preventDefault()
                if (dragF && dragF.pid === l.pid) reorderFields(l.pid!, dragF.f, l.field!, dropSide(e))
                setDragF(null)
                setDropAt(null)
              }
            : undefined
        }
        onDragEnd={drag ? () => { setDragF(null); setDropAt(null) } : undefined}
        title={drag ? 'Drag to reorder · click to sort' : 'Click to sort (Shift = add)'}
        className={`${headTh} whitespace-nowrap overflow-hidden hover:text-citrus-pink ${drag ? 'cursor-move' : 'cursor-pointer'} ${div} ${
          dragF?.pid === l.pid && dragF?.f === l.field ? 'opacity-40' : ''
        } ${dropAt?.colId === l.colId ? 'bg-citrus-pink-light/50 dark:bg-citrus-night-elev/60' : ''}`}
        onClick={(e) => table.getColumn(l.colId)?.toggleSorting(undefined, e.shiftKey)}
      >
        <span className="truncate">{l.ckind === 'status' ? 'Status' : l.ckind === 'source' ? 'Checked' : l.field}</span>
        {sortBadge(l.colId)}
        {colDots(l.colId)}
        {resizeHandle(l.colId)}
        {dropLine(l.colId)}
      </th>
    )
  }

  const hasFilter = globalFilter.trim() !== '' || columnFilters.length > 0
  const indW = isVis('value') ? widthOf('value') : 0
  // Pinning: freeze the identity block (select · # · Indicator · Kind) on the left so it stays
  // visible while scrolling wide provider buckets. Offsets are cumulative from current widths.
  const PIN_VALUE_L = SELECT_W + NUM_W
  const PIN_KIND_L = SELECT_W + NUM_W + indW
  const headPin = 'bg-citrus-cream dark:bg-citrus-night'
  const pinBg = (sel: boolean): string => (sel ? 'bg-citrus-pink-light dark:bg-citrus-night-elev' : 'bg-citrus-cream dark:bg-citrus-night')
  const sticky = (left: number, w: number, z: number): React.CSSProperties => ({ position: 'sticky', left, width: w, minWidth: w, maxWidth: w, zIndex: z })
  // Total width of the frozen identity block, and the id of its last column. Scrolled columns pass
  // UNDER this block, so without an edge shadow a half-hidden column reads as a mystery header
  // ("Network" showing only "work") rather than as content sliding beneath.
  const pinnedW = SELECT_W + NUM_W + indW + (isVis('kind') ? widthOf('kind') : 0)
  const lastPinnedId = isVis('kind') ? 'kind' : isVis('value') ? 'value' : null
  const PIN_EDGE = 'shadow-[8px_0_8px_-8px_rgba(35,39,38,0.35)] dark:shadow-[8px_0_8px_-8px_rgba(0,0,0,0.75)]'
  const pinEdge = (colId: string): string => (colId === lastPinnedId ? PIN_EDGE : '')
  const totalCols = 2 + (isVis('value') ? 1 : 0) + (isVis('kind') ? 1 : 0) + visBuckets.reduce((n, b) => n + b.count, 0)

  return (
    <>
      {/* Filter / toolbar bar */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-1.5 border-b border-citrus-border dark:border-citrus-night-border">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-citrus-muted dark:text-citrus-night-muted" />
          <input
            ref={searchRef}
            value={globalFilter}
            onChange={(e) => setGlobalFilter(e.target.value)}
            placeholder="Search all columns…"
            title="Matches any text in the row"
            className="w-56 rounded-md border border-citrus-border bg-citrus-cream pl-7 pr-6 py-1 text-xs text-citrus-dark outline-none focus:border-citrus-pink dark:border-citrus-night-border dark:bg-citrus-night dark:text-citrus-night-text"
          />
          {globalFilter && (
            <button onClick={() => setGlobalFilter('')} title="Clear search" className="absolute right-1.5 top-1/2 -translate-y-1/2 text-citrus-muted hover:text-citrus-pink">
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
        {columnFilters.map((f) => (
          <button
            key={f.id}
            onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setColMenu({ colId: f.id, x: r.left, y: r.bottom }) }}
            title="Edit this filter"
            className="inline-flex items-center gap-1 rounded-full border border-citrus-pink/40 bg-citrus-pink-light/60 px-2 py-0.5 text-[11px] text-citrus-pink dark:bg-citrus-night-elev"
          >
            <Filter className="w-3 h-3" />
            <span className="font-semibold">{labelFor(f.id)}</span>
            <span className="text-citrus-pink/80">({(f.value as string[]).length})</span>
            <span onClick={(e) => { e.stopPropagation(); table.getColumn(f.id)?.setFilterValue(undefined) }} title="Remove filter" className="hover:text-citrus-pink-hover">
              <X className="w-3 h-3" />
            </span>
          </button>
        ))}
        {hasFilter && (
          <button onClick={() => { setGlobalFilter(''); setColumnFilters([]) }} className="text-[11px] text-citrus-muted hover:text-citrus-pink dark:text-citrus-night-muted">
            Clear all
          </button>
        )}
        {grouping.map((colId) => (
          <span key={colId} className="inline-flex items-center gap-1 rounded-full border border-citrus-pink/40 bg-citrus-pink-light/40 px-2 py-0.5 text-[11px] text-citrus-pink dark:bg-citrus-night-elev">
            <Layers className="w-3 h-3" />
            <span className="font-semibold">{labelFor(colId)}</span>
            <button onClick={() => table.getColumn(colId)?.toggleGrouping()} title="Remove grouping" className="hover:text-citrus-pink-hover">
              <X className="w-3 h-3" />
            </button>
          </span>
        ))}
        <div className="ml-auto flex items-center gap-2">
          {hasFilter && (
            <span className="text-[11px] font-mono text-citrus-muted dark:text-citrus-night-muted">
              {rows.length} of {indicators.length}
            </span>
          )}
          {/* Columns picker */}
          <div className="relative">
            <button
              onClick={() => setColsOpen((o) => !o)}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold border border-citrus-border text-citrus-dark hover:bg-citrus-sand/60 transition-colors dark:border-citrus-night-border dark:text-citrus-night-text dark:hover:bg-citrus-night-elev"
              title="Show / hide columns"
            >
              <Columns3 className="w-3 h-3" /> Columns
            </button>
            {colsOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setColsOpen(false)} />
                <div className="absolute right-0 top-full z-50 mt-1 max-h-80 w-56 overflow-auto rounded-lg border border-citrus-border bg-citrus-card py-1 shadow-lg dark:border-citrus-night-border dark:bg-citrus-night-card">
                  {leaves.map((l) => (
                    <Fragment key={l.colId}>
                      {l.firstInBucket && (
                        <div className="mt-1 flex items-center justify-between px-3 py-0.5 text-[10px] font-bold uppercase tracking-wide text-citrus-pink">
                          {providerName(l.pid!)}
                        </div>
                      )}
                      <button
                        onClick={() => table.getColumn(l.colId)?.toggleVisibility()}
                        className="flex w-full items-center gap-2 px-3 py-1 text-left text-[11px] text-citrus-dark hover:bg-citrus-pink-light/50 dark:text-citrus-night-text dark:hover:bg-citrus-night-elev"
                      >
                        <span className={`shrink-0 w-3.5 h-3.5 rounded-sm border flex items-center justify-center ${isVis(l.colId) ? 'bg-citrus-pink border-citrus-pink text-white' : 'border-citrus-border dark:border-citrus-night-border'}`}>
                          {isVis(l.colId) && <Check className="w-2.5 h-2.5" />}
                        </span>
                        <span className="truncate">{l.ckind === 'status' ? 'Status' : l.ckind === 'source' ? 'Checked' : l.ckind === 'field' ? l.field : l.label}</span>
                      </button>
                    </Fragment>
                  ))}
                  <button onClick={() => table.resetColumnVisibility()} className="mt-1 w-full border-t border-citrus-border/60 px-3 py-1.5 text-left text-[11px] font-semibold text-citrus-muted hover:text-citrus-pink dark:border-citrus-night-border/60 dark:text-citrus-night-muted">
                    Show all
                  </button>
                </div>
              </>
            )}
          </div>
          <button
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold border border-citrus-border text-citrus-dark hover:bg-citrus-sand/60 transition-colors disabled:opacity-40 dark:border-citrus-night-border dark:text-citrus-night-text dark:hover:bg-citrus-night-elev"
            onClick={() => setExportOpen(true)}
            disabled={selectedValues.length === 0}
            title={selectedValues.length === 0 ? 'Select rows to export' : `Export ${selectedValues.length} selected row(s) to CSV`}
          >
            <Download className="w-3 h-3" /> Export CSV
          </button>
          {/* The way BACK to class grouping. The `class` column is grouping-only and has no header,
              so it has no column menu — without this, dismissing the Class chip would be one-way. */}
          <button
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold border transition-colors ${
              grouping.includes('class')
                ? 'border-citrus-pink/40 text-citrus-pink bg-citrus-pink-light/60 dark:bg-citrus-night-elev'
                : 'border-citrus-border text-citrus-muted hover:text-citrus-pink dark:border-citrus-night-border dark:text-citrus-night-muted'
            }`}
            onClick={() => table.getColumn('class')?.toggleGrouping()}
            title="Group indicators into Network / File / Other sections"
          >
            <Layers className="w-3 h-3" /> Sections
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
        </div>
      </div>

      {/* Grid */}
      <div ref={gridRef} tabIndex={0} onKeyDown={onGridKeyDown} className="pane__text--out flex-1 min-h-0 overflow-auto px-2 py-2 outline-none">
        {indicators.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-citrus-muted dark:text-citrus-night-muted">
            No indicators yet — paste some above, or Send to Intel.
          </div>
        ) : rows.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-citrus-muted dark:text-citrus-night-muted">
            No results match the filter.
            <button onClick={() => { setGlobalFilter(''); setColumnFilters([]) }} className="rounded-md border border-citrus-border px-2 py-0.5 text-xs font-semibold hover:border-citrus-pink/40 hover:text-citrus-pink dark:border-citrus-night-border">
              Clear filters
            </button>
          </div>
        ) : (
          <table className="text-xs" style={{ width: totalWidth, tableLayout: 'fixed' }}>
            <thead className="sticky top-0 z-10 bg-citrus-cream/95 backdrop-blur dark:bg-citrus-night/95">
              {/* Group row: provider buckets (draggable to reorder), empty over the leading cols. */}
              <tr className="text-left text-citrus-muted dark:text-citrus-night-muted">
                <th style={sticky(0, SELECT_W, 30)} className={headPin} />
                <th style={sticky(SELECT_W, NUM_W, 30)} className={headPin} />
                {isVis('value') && (
                  <th rowSpan={2} style={sticky(PIN_VALUE_L, indW, 30)} className={`${headTh} ${headPin} cursor-pointer hover:text-citrus-pink`} onClick={(e) => table.getColumn('value')?.toggleSorting(undefined, e.shiftKey)}>
                    Indicator{sortBadge('value')}
                    {colDots('value')}
                    {resizeHandle('value')}
                  </th>
                )}
                {isVis('kind') && (
                  <th rowSpan={2} style={sticky(PIN_KIND_L, widthOf('kind'), 30)} className={`${headTh} ${headPin} ${pinEdge('kind')} cursor-pointer hover:text-citrus-pink`} onClick={(e) => table.getColumn('kind')?.toggleSorting(undefined, e.shiftKey)}>
                    Kind{sortBadge('kind')}
                    {colDots('kind')}
                    {resizeHandle('kind')}
                  </th>
                )}
                {visBuckets.map((b) => (
                  <th
                    key={b.pid}
                    colSpan={b.count}
                    draggable
                    onDragStart={(e) => { setDragP(b.pid); e.dataTransfer.effectAllowed = 'move' }}
                    onDragOver={(e) => {
                      if (!dragP || dragP === b.pid) return
                      e.preventDefault()
                      e.dataTransfer.dropEffect = 'move'
                      const side = dropSide(e)
                      const colId = `bucket:${b.pid}`
                      setDropAt((d) => (d?.colId === colId && d.side === side ? d : { colId, side }))
                    }}
                    onDrop={(e) => {
                      e.preventDefault()
                      if (dragP) reorderProviders(dragP, b.pid, dropSide(e))
                      setDragP(null)
                      setDropAt(null)
                    }}
                    onDragEnd={() => { setDragP(null); setDropAt(null) }}
                    title="Drag to reorder this bucket"
                    className={`relative px-2 py-1 font-bold text-left text-citrus-pink border-l-[3px] border-citrus-pink/50 dark:border-citrus-pink/40 cursor-move ${
                      dragP === b.pid ? 'opacity-40' : ''
                    } ${dropAt?.colId === `bucket:${b.pid}` ? 'bg-citrus-pink-light/50 dark:bg-citrus-night-elev/60' : ''}`}
                  >
                    {/* Sticky, not centered. A bucket is routinely wider than the viewport, so centering
                        parked the label at the colSpan's midpoint — often off-screen, or stranded over
                        the frozen columns with none of its own in sight. Sticking it just right of the
                        frozen block keeps it beside its columns, and it slides away with them. */}
                    <span className="sticky inline-block" style={{ left: pinnedW + 8 }}>
                      {b.name}
                    </span>
                    {dropLine(`bucket:${b.pid}`)}
                  </th>
                ))}
              </tr>
              {/* Leaf row: select-all, #, then each visible provider leaf. */}
              <tr className="text-left text-citrus-muted dark:text-citrus-night-muted">
                <th style={sticky(0, SELECT_W, 30)} className={`px-2 py-1 ${headPin}`}>
                  <input ref={headerBoxRef} type="checkbox" checked={table.getIsAllRowsSelected()} onChange={table.getToggleAllRowsSelectedHandler()} />
                </th>
                <th style={sticky(SELECT_W, NUM_W, 30)} className={`px-2 py-1 text-right font-semibold ${headPin}`}>#</th>
                {visBuckets.flatMap((b) => {
                  const ls: Leaf[] = []
                  if (b.showStatus) ls.push({ colId: `p:${b.pid}:status`, label: `${b.name} Status`, pid: b.pid, ckind: 'status', firstInBucket: true })
                  for (const f of b.fields) ls.push({ colId: `p:${b.pid}:f:${f}`, label: `${b.name} ${f}`, pid: b.pid, ckind: 'field', field: f })
                  if (b.showSource) ls.push({ colId: `p:${b.pid}:source`, label: `${b.name} Source`, pid: b.pid, ckind: 'source' })
                  // The first leaf of the bucket carries the divider.
                  if (ls[0]) ls[0] = { ...ls[0], firstInBucket: true }
                  return ls.map(leafHeader)
                })}
              </tr>
            </thead>
            <tbody>
              {/* Top spacer: stands in for the rows scrolled off above, so table layout + the
                  running # column stay correct without mounting those rows. */}
              {padTop > 0 && (
                <tr aria-hidden>
                  <td colSpan={totalCols} style={{ height: padTop }} className="p-0 border-0" />
                </tr>
              )}
              {virtualRows.map((vrow) => {
                const i = vrow.index
                const row = rows[i]
                // Group summary row: a sticky caret + grouped value + count; expand to see members.
                if (row.getIsGrouped()) {
                  const gcol = row.groupingColumnId!
                  const val = String(row.getGroupingValue(gcol) ?? '')
                  return (
                    <tr
                      key={row.id}
                      data-index={i}
                      ref={rowVirtualizer.measureElement}
                      className="cursor-pointer select-none border-t border-citrus-border/60 bg-citrus-sand/40 hover:bg-citrus-sand/60 dark:border-citrus-night-border/60 dark:bg-citrus-night-elev/50 dark:hover:bg-citrus-night-elev/70"
                      onClick={row.getToggleExpandedHandler()}
                    >
                      <td style={sticky(0, SELECT_W, 20)} className="px-2 py-1 bg-citrus-sand/40 dark:bg-citrus-night-elev/50" />
                      <td
                        colSpan={totalCols - 1}
                        style={{ position: 'sticky', left: SELECT_W, zIndex: 20 }}
                        className="px-2 py-1 bg-citrus-sand/40 dark:bg-citrus-night-elev/50 text-citrus-dark dark:text-citrus-night-text whitespace-nowrap"
                      >
                        <span style={{ paddingLeft: row.depth * 14 }} className="inline-flex items-center gap-1.5">
                          {row.getIsExpanded() ? <ChevronDown className="w-3.5 h-3.5 text-citrus-pink" /> : <ChevronRight className="w-3.5 h-3.5 text-citrus-pink" />}
                          <span className="text-citrus-muted dark:text-citrus-night-muted">{labelFor(gcol)}:</span>
                          <strong className="font-mono">{val === '' ? '∅ (empty)' : val}</strong>
                          <span className="text-citrus-muted dark:text-citrus-night-muted">({row.subRows.length})</span>
                        </span>
                      </td>
                    </tr>
                  )
                }
                const rr = row.original
                const isSel = row.getIsSelected()
                return (
                  <tr
                    key={rr.value}
                    data-index={i}
                    ref={rowVirtualizer.measureElement}
                    className={`cursor-pointer select-none border-t border-citrus-border/60 dark:border-citrus-night-border/60 hover:bg-citrus-sand/30 dark:hover:bg-citrus-night-elev/40 ${
                      isSel ? 'bg-citrus-pink-light/50 dark:bg-citrus-night-elev/70' : i % 2 === 1 ? 'bg-citrus-sand/15 dark:bg-citrus-night-card/30' : ''
                    }`}
                    onMouseDown={(e) => rowMouseDown(e, i, rr.value)}
                    onMouseEnter={() => rowMouseEnter(i)}
                    onContextMenu={(e) => openMenu(e, rr.value)}
                  >
                    <td style={sticky(0, SELECT_W, 20)} className={`px-2 py-1 ${pinBg(isSel)}`}>
                      <input type="checkbox" checked={isSel} onMouseDown={(e) => e.stopPropagation()} onChange={row.getToggleSelectedHandler()} />
                    </td>
                    <td style={sticky(SELECT_W, NUM_W, 20)} className={`px-2 py-1 text-right font-mono tabular-nums text-citrus-muted/70 dark:text-citrus-night-muted/70 ${pinBg(isSel)}`}>{i + 1}</td>
                    {isVis('value') && <ValueCell text={rr.value} wrap={wrap} mono style={sticky(PIN_VALUE_L, indW, 20)} className={`${pinBg(isSel)} ${pinEdge('value')}`} />}
                    {isVis('kind') && (
                      <td style={sticky(PIN_KIND_L, widthOf('kind'), 20)} className={`px-2 py-1 font-mono text-citrus-muted dark:text-citrus-night-muted overflow-hidden text-ellipsis whitespace-nowrap ${pinBg(isSel)} ${pinEdge('kind')}`}>
                        {rr.kind}
                      </td>
                    )}
                    {visBuckets.map((b) => {
                      const r = rr.byP[b.pid]
                      const sw = widthOf(`p:${b.pid}:status`)
                      return (
                        <Fragment key={b.pid}>
                          {b.showStatus && (
                            <td style={{ width: sw, minWidth: sw, maxWidth: sw }} className="px-2 py-1 border-l-[3px] border-citrus-pink/40 dark:border-citrus-pink/30 overflow-hidden whitespace-nowrap">
                              {r ? (
                                <StatusCell verdictField={b.verdictField!} r={r} />
                              ) : (
                                <span className="text-citrus-muted/50 dark:text-citrus-night-muted/50">—</span>
                              )}
                            </td>
                          )}
                          {b.fields.map((f, fi) => {
                            const fw = widthOf(`p:${b.pid}:f:${f}`)
                            const style = { width: fw, minWidth: fw, maxWidth: fw }
                            // The bucket's left divider normally rides on the Status cell; without one
                            // it has to move to the first field, or the bucket loses its boundary.
                            const div = !b.showStatus && fi === 0 ? 'border-l-[3px] border-citrus-pink/40 dark:border-citrus-pink/30' : ''
                            // A verdict-less provider has no Status column, so a failed lookup would
                            // otherwise be a silently blank row. Surface it in the bucket's first cell.
                            if (!b.showStatus && fi === 0 && r && r.status !== 'ok') {
                              return (
                                <td key={f} style={style} className={`px-2 py-1 ${div} overflow-hidden whitespace-nowrap`}>
                                  <ProblemChip r={r} />
                                </td>
                              )
                            }
                            if (b.pid === 'watchlist' && f === 'Lists') {
                              return (
                                <td key={f} style={style} className={`px-2 py-1 ${div} align-top overflow-hidden`}>
                                  {r?.fields[f] ? (
                                    <span className="flex flex-wrap gap-1">
                                      {r.fields[f].split(', ').map((name) => (
                                        <button
                                          key={name}
                                          onClick={() => setGlobalFilter(name)}
                                          title={`Filter to “${name}”`}
                                          className="inline-block rounded-full bg-citrus-pink-light px-1.5 py-0.5 text-[10px] font-semibold text-citrus-pink hover:bg-citrus-pink hover:text-white dark:bg-citrus-night-elev"
                                        >
                                          {name}
                                        </button>
                                      ))}
                                    </span>
                                  ) : (
                                    <span className="text-citrus-muted/40 dark:text-citrus-night-muted/40">—</span>
                                  )}
                                </td>
                              )
                            }
                            if (b.pid === 'virustotal' && f === 'VT Link') {
                              const url = r?.fields[f]
                              return (
                                <td key={f} style={style} className={`px-2 py-1 ${div} overflow-hidden whitespace-nowrap`}>
                                  {url ? (
                                    <button
                                      onClick={() => void window.api.enrich.openExternal(url)}
                                      title={url}
                                      className="inline-flex items-center gap-1 text-[11px] font-semibold text-citrus-pink hover:underline"
                                    >
                                      View <ExternalLink className="w-3 h-3" />
                                    </button>
                                  ) : (
                                    <span className="text-citrus-muted/40 dark:text-citrus-night-muted/40">—</span>
                                  )}
                                </td>
                              )
                            }
                            return <ValueCell key={f} text={r?.fields[f] ?? ''} wrap={wrap} style={style} className={div} />
                          })}
                          {b.showSource && (
                            <td
                              style={{ width: widthOf(`p:${b.pid}:source`) }}
                              className="px-2 py-1 text-[10px] text-citrus-muted dark:text-citrus-night-muted overflow-hidden whitespace-nowrap"
                              title={r?.fetchedAt ? `Looked up ${new Date(r.fetchedAt).toLocaleString()}` : undefined}
                            >
                              {/* WHEN it was looked up, for every provider. Cached results never auto-expire,
                                  so the age is the thing worth knowing — "cached"/"fresh" said nothing. */}
                              {r?.fetchedAt ? agoLabel(r.fetchedAt) : ''}
                            </td>
                          )}
                        </Fragment>
                      )
                    })}
                  </tr>
                )
              })}
              {padBottom > 0 && (
                <tr aria-hidden>
                  <td colSpan={totalCols} style={{ height: padBottom }} className="p-0 border-0" />
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {colMenu && (
        <ColMenu
          label={labelFor(colMenu.colId)}
          distinct={distinctFor(colMenu.colId)}
          current={(table.getColumn(colMenu.colId)?.getFilterValue() as string[]) ?? []}
          grouped={!!table.getColumn(colMenu.colId)?.getIsGrouped()}
          x={colMenu.x}
          y={colMenu.y}
          onApply={(vals) => table.getColumn(colMenu.colId)?.setFilterValue(vals.length ? vals : undefined)}
          onToggleGroup={() => table.getColumn(colMenu.colId)?.toggleGrouping()}
          onClose={() => setColMenu(null)}
        />
      )}

      {menu && (
        <div
          className="fixed z-50 min-w-[200px] flex flex-col rounded-lg border border-citrus-border bg-citrus-card shadow-lg overflow-hidden dark:border-citrus-night-border dark:bg-citrus-night-card"
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
              onClick={() => { onRun(p.id, menu.targets); setMenu(null) }}
            >
              <Radar className="w-3.5 h-3.5 shrink-0 text-citrus-pink" />
              {p.name}
              {!p.ready && <span className="ml-auto text-[10px] text-citrus-muted dark:text-citrus-night-muted">needs config</span>}
            </button>
          ))}
          <button
            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs text-citrus-dark hover:bg-citrus-pink-light/60 border-t border-citrus-border/60 dark:text-citrus-night-text dark:hover:bg-citrus-night-elev dark:border-citrus-night-border/60"
            onClick={() => { void navigator.clipboard.writeText(selectedIndicators(menu.targets)); setMenu(null) }}
          >
            <Copy className="w-3.5 h-3.5 shrink-0 text-citrus-pink" />
            Copy indicator{menu.targets.length > 1 ? 's' : ''}
            <span className="ml-auto text-[10px] text-citrus-muted dark:text-citrus-night-muted">Ctrl+Shift+C</span>
          </button>
          <button
            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs text-citrus-dark hover:bg-citrus-pink-light/60 dark:text-citrus-night-text dark:hover:bg-citrus-night-elev"
            onClick={() => { void navigator.clipboard.writeText(buildCsv(menu.targets)); setMenu(null) }}
          >
            <Copy className="w-3.5 h-3.5 shrink-0 text-citrus-pink" />
            Copy as CSV
            <span className="ml-auto text-[10px] text-citrus-muted dark:text-citrus-night-muted">Ctrl+C</span>
          </button>
          <button
            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs text-citrus-dark hover:bg-citrus-pink-light/60 dark:text-citrus-night-text dark:hover:bg-citrus-night-elev"
            onClick={() => { onSweep(menu.targets); setMenu(null) }}
          >
            <Crosshair className="w-3.5 h-3.5 shrink-0 text-red-500 dark:text-red-400" />
            Run Intel Sweep{menu.targets.length > 1 ? ` (${menu.targets.length})` : ''}…
          </button>
          <button
            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs text-citrus-dark hover:bg-citrus-pink-light/60 dark:text-citrus-night-text dark:hover:bg-citrus-night-elev"
            onClick={() => { onClearCache(menu.targets); setMenu(null) }}
          >
            <Eraser className="w-3.5 h-3.5 shrink-0 text-citrus-muted dark:text-citrus-night-muted" />
            Clear cached results
          </button>
          <button
            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs text-citrus-dark hover:bg-citrus-pink-light/60 dark:text-citrus-night-text dark:hover:bg-citrus-night-elev"
            onClick={() => { onRemove(menu.targets); setRowSelection({}); setMenu(null) }}
          >
            <Trash2 className="w-3.5 h-3.5 shrink-0 text-citrus-muted dark:text-citrus-night-muted" />
            Remove from list
          </button>
        </div>
      )}

      {exportOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={() => setExportOpen(false)}>
          <div className="w-[22rem] max-w-[90vw] rounded-xl border border-citrus-border bg-citrus-card p-5 shadow-lg dark:border-citrus-night-border dark:bg-citrus-night-card" onClick={(e) => e.stopPropagation()}>
            <div className="text-sm font-bold text-citrus-dark dark:text-citrus-night-text">Export to CSV</div>
            <p className="mt-2 text-xs text-citrus-muted dark:text-citrus-night-muted">
              Export <strong className="text-citrus-dark dark:text-citrus-night-text">{selectedValues.length}</strong>{' '}
              {selectedValues.length === 1 ? 'event' : 'events'} to a CSV file.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button className="px-3 py-1 rounded-md text-[11px] font-bold border border-citrus-border text-citrus-muted hover:text-citrus-pink hover:border-citrus-pink/40 transition-colors dark:border-citrus-night-border dark:text-citrus-night-muted" onClick={() => setExportOpen(false)}>
                Cancel
              </button>
              <button className="inline-flex items-center gap-1 px-3 py-1 rounded-md text-[11px] font-bold bg-citrus-pink text-white hover:bg-citrus-pink-hover transition-colors" onClick={() => void exportCsv()}>
                <Download className="w-3 h-3" /> Export
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
