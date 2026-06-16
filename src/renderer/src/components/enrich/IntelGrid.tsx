import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  type ColumnDef,
  type FilterFn,
  type SortingState,
  type ColumnFiltersState,
  type RowSelectionState
} from '@tanstack/react-table'
import { Check, Copy, Download, Eraser, Filter, MoreVertical, Radar, Search, Trash2, X } from 'lucide-react'
import type { EnrichItem, EnrichProviderInfo, EnrichResultRow } from '../../state/enrichTypes'

// The Intel results grid, built on TanStack Table (headless): TanStack owns the STATE + models —
// sorting, the per-column multi-select filters, the global (whole-row) search, faceted distinct
// values for the column menu, and row selection — while we render the header/body ourselves so the
// provider-bucket layout, dividers, badges, and chips stay exactly as designed. The dataset is the
// indicators the user added (small, in-memory), so there's no virtualization or SQL here.
//
// This is also the reusable template for a possible future TanStack migration of the CSV/workspace
// grid (which would run in manual* mode against the SQLite worker + TanStack Virtual).

type ResultMap = Record<string, Record<string, EnrichResultRow>>

const STATUS_STYLE: Record<string, string> = {
  ok: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  notfound: 'bg-citrus-sand text-citrus-muted dark:bg-citrus-night-elev dark:text-citrus-night-muted',
  error: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  skipped: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  private: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300'
}

// Preferred field order for known MaxMind-ish fields (others append, first-seen).
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
/** Order `keys` by a saved user list (known first, in order); the rest keep their order, appended. */
function orderByList(keys: string[], order: string[]): string[] {
  const known = order.filter((k) => keys.includes(k))
  const rest = keys.filter((k) => !order.includes(k))
  return [...known, ...rest]
}

/** One leaf column descriptor — drives both the TanStack column (state) and our manual render. */
interface Leaf {
  colId: string
  label: string
  pid?: string
  ckind: 'indicator' | 'kind' | 'status' | 'source' | 'field'
  field?: string
  firstInBucket?: boolean
}
/** A flattened row: pure cell values for TanStack accessors + the raw results for rich rendering. */
interface IntelRow {
  value: string
  kind: string
  cells: Record<string, string>
  byP: Record<string, EnrichResultRow>
  hay: string
}

/** A value cell with a hover "copy" button and a wrap/truncate mode. */
function ValueCell({ text, wrap, mono }: { text: string; wrap: boolean; mono?: boolean }): JSX.Element {
  const [done, setDone] = useState(false)
  return (
    <td
      className={`relative group px-2 py-1 ${wrap ? 'whitespace-normal break-words max-w-[16rem]' : 'whitespace-nowrap'} ${
        mono ? 'font-mono' : ''
      } text-citrus-dark dark:text-citrus-night-text`}
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
// "All" checked = no filter. The distinct values are passed in from TanStack's faceted model.
function ColMenu({ label, distinct, current, x, y, onApply, onClose }: {
  label: string
  distinct: Array<{ value: string; count: number }>
  current: string[]
  x: number
  y: number
  onApply: (values: string[]) => void
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
  onReorder,
  onRun,
  onClearCache,
  onRemove
}: {
  indicators: EnrichItem[]
  results: ResultMap
  providers: EnrichProviderInfo[]
  providerOrder?: string[]
  fieldOrder?: Record<string, string[]>
  onReorder: (patch: { providerOrder?: string[]; fieldOrder?: Record<string, string[]> }) => void
  onRun: (providerId: string, values: string[]) => void
  onClearCache: (values: string[]) => void
  onRemove: (values: string[]) => void
}): JSX.Element {
  const providerName = (pid: string): string => providers.find((p) => p.id === pid)?.name ?? pid

  // Which provider buckets appear (have any result), ordered by the saved doc order.
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

  // Ordered leaf descriptors (the visible columns) + the bucket grouping for the header.
  const leaves = useMemo<Leaf[]>(() => {
    const out: Leaf[] = [
      { colId: 'value', label: 'Indicator', ckind: 'indicator' },
      { colId: 'kind', label: 'Kind', ckind: 'kind' }
    ]
    for (const pid of providerIds) {
      const name = providerName(pid)
      out.push({ colId: `p:${pid}:status`, label: `${name} Status`, pid, ckind: 'status', firstInBucket: true })
      for (const f of fieldsByProvider[pid]) out.push({ colId: `p:${pid}:f:${f}`, label: `${name} ${f}`, pid, ckind: 'field', field: f })
      out.push({ colId: `p:${pid}:source`, label: `${name} Source`, pid, ckind: 'source' })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerIds, fieldsByProvider, providers])

  // Flattened rows: pure cell strings (for TanStack accessors/facets) + the raw provider results.
  const data = useMemo<IntelRow[]>(() => {
    return indicators.map((ind) => {
      const byP = results[ind.value] ?? {}
      const cells: Record<string, string> = { value: ind.value, kind: ind.kind }
      let hay = `${ind.value} ${ind.kind}`
      for (const pid of Object.keys(byP)) {
        const r = byP[pid]
        cells[`p:${pid}:status`] = r.status
        cells[`p:${pid}:source`] = r.fromCache ? 'cached' : 'fresh'
        hay += ` ${r.status} ${r.message ?? ''}`
        for (const f of Object.keys(r.fields)) {
          cells[`p:${pid}:f:${f}`] = r.fields[f]
          hay += ` ${r.fields[f]}`
        }
      }
      return { value: ind.value, kind: ind.kind, cells, byP, hay: hay.toLowerCase() }
    })
  }, [indicators, results])

  // Custom filter: keep rows whose cell value is one of the checked distinct values (empty = no-op).
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
      enableGlobalFilter: false
    }))
    // Hidden whole-row haystack column — the global search box matches this (incl. status messages).
    cols.push({ id: '__search', accessorFn: (r) => r.hay, enableGlobalFilter: true, enableSorting: false })
    return cols
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leaves])

  const [sorting, setSorting] = useState<SortingState>([])
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const [globalFilter, setGlobalFilter] = useState('')
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({})

  const table = useReactTable({
    data,
    columns,
    state: { sorting, columnFilters, globalFilter, rowSelection },
    getRowId: (r) => r.value,
    filterFns: { inSet },
    globalFilterFn: 'includesString',
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    onRowSelectionChange: setRowSelection,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues()
  })

  const rows = table.getRowModel().rows
  const visibleValues = useMemo(() => rows.map((r) => r.original.value), [rows])
  const labelFor = (colId: string): string => leaves.find((l) => l.colId === colId)?.label ?? colId

  // --- column menu (distinct/filter) ---
  const [colMenu, setColMenu] = useState<{ colId: string; x: number; y: number } | null>(null)
  const distinctFor = (colId: string): Array<{ value: string; count: number }> => {
    const m = table.getColumn(colId)?.getFacetedUniqueValues()
    if (!m) return []
    return [...m.entries()]
      .map(([value, count]) => ({ value: String(value ?? ''), count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, undefined, { numeric: true }))
  }

  // --- Excel-style row highlight (active rows) — independent of the tick boxes. ---
  const [highlighted, setHighlighted] = useState<Set<string>>(new Set())
  const anchorRef = useRef(-1)
  const focusRef = useRef(-1)
  const dragRef = useRef(false)
  const gridRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onUp = (): void => {
      dragRef.current = false
    }
    window.addEventListener('mouseup', onUp)
    return () => window.removeEventListener('mouseup', onUp)
  }, [])
  function highlightRange(a: number, b: number): void {
    const lo = Math.min(a, b)
    const hi = Math.max(a, b)
    setHighlighted(new Set(visibleValues.slice(lo, hi + 1)))
  }
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
  function onGridKeyDown(e: React.KeyboardEvent): void {
    if ((e.key !== 'ArrowDown' && e.key !== 'ArrowUp') || visibleValues.length === 0) return
    e.preventDefault()
    if (focusRef.current < 0) {
      anchorRef.current = 0
      focusRef.current = 0
      setHighlighted(new Set([visibleValues[0]]))
      return
    }
    const next = Math.min(visibleValues.length - 1, Math.max(0, focusRef.current + (e.key === 'ArrowDown' ? 1 : -1)))
    focusRef.current = next
    if (e.shiftKey) highlightRange(anchorRef.current, next)
    else {
      anchorRef.current = next
      setHighlighted(new Set([visibleValues[next]]))
    }
  }

  // --- selection (tick boxes, via TanStack rowSelection) ---
  const selectedValues = useMemo(() => Object.keys(rowSelection).filter((k) => rowSelection[k]), [rowSelection])
  const headerBoxRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (headerBoxRef.current) headerBoxRef.current.indeterminate = table.getIsSomeRowsSelected() && !table.getIsAllRowsSelected()
  }, [rowSelection, table])

  // --- right-click context menu ---
  const [menu, setMenu] = useState<{ x: number; y: number; targets: string[] } | null>(null)
  function openMenu(e: React.MouseEvent, value: string): void {
    e.preventDefault()
    let targets: string[]
    if (rowSelection[value] && selectedValues.length > 0) targets = selectedValues
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

  // --- CSV build (copy + export), in current display order over a set of values ---
  function buildCsv(values: string[]): string {
    const set = new Set(values)
    const lines = [leaves.map((l) => csvEsc(l.label)).join(',')]
    for (const r of rows) {
      if (!set.has(r.original.value)) continue
      lines.push(leaves.map((l) => csvEsc(r.original.cells[l.colId] ?? '')).join(','))
    }
    return lines.join('\n')
  }
  const [exportOpen, setExportOpen] = useState(false)
  async function exportCsv(): Promise<void> {
    setExportOpen(false)
    await window.api.saveFile(buildCsv(selectedValues), 'intel.csv')
  }

  // --- column reorder (drag bucket / field headers); persisted via onReorder(doc order) ---
  const [dragP, setDragP] = useState<string | null>(null)
  const [dragF, setDragF] = useState<{ pid: string; f: string } | null>(null)
  function reorderProviders(from: string, to: string): void {
    if (from === to) return
    const next = providerIds.filter((p) => p !== from)
    const idx = next.indexOf(to)
    next.splice(idx < 0 ? next.length : idx, 0, from)
    onReorder({ providerOrder: next })
  }
  function reorderFields(pid: string, from: string, to: string): void {
    if (from === to) return
    const next = fieldsByProvider[pid].filter((f) => f !== from)
    const idx = next.indexOf(to)
    next.splice(idx < 0 ? next.length : idx, 0, from)
    onReorder({ fieldOrder: { ...(fieldOrder ?? {}), [pid]: next } })
  }

  const [wrap, setWrap] = useState(false)

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
  function sortArrow(colId: string): string {
    const d = table.getColumn(colId)?.getIsSorted()
    return d === 'asc' ? ' ▲' : d === 'desc' ? ' ▼' : ''
  }
  // A leaf header cell: click to sort, 3-dots to filter, draggable (field columns) to reorder.
  function leafHeader(l: Leaf): JSX.Element {
    const div = l.firstInBucket ? 'border-l-[3px] border-citrus-pink/50 dark:border-citrus-pink/40' : ''
    const drag = l.ckind === 'field' && l.pid
    return (
      <th
        key={l.colId}
        draggable={!!drag}
        onDragStart={drag ? () => setDragF({ pid: l.pid!, f: l.field! }) : undefined}
        onDragOver={drag ? (e) => e.preventDefault() : undefined}
        onDrop={drag ? () => { if (dragF && dragF.pid === l.pid) reorderFields(l.pid!, dragF.f, l.field!); setDragF(null) } : undefined}
        onDragEnd={drag ? () => setDragF(null) : undefined}
        title={drag ? 'Drag to reorder · click to sort' : 'Click to sort'}
        className={`px-2 py-1 font-semibold whitespace-nowrap select-none hover:text-citrus-pink ${drag ? 'cursor-move' : 'cursor-pointer'} ${div} ${
          dragF?.pid === l.pid && dragF?.f === l.field ? 'opacity-40' : ''
        }`}
        onClick={() => table.getColumn(l.colId)?.toggleSorting()}
      >
        {l.ckind === 'status' ? 'Status' : l.ckind === 'source' ? 'Source' : l.ckind === 'field' ? l.field : l.label}
        {sortArrow(l.colId)}
        {colDots(l.colId)}
      </th>
    )
  }

  const hasFilter = globalFilter.trim() !== '' || columnFilters.length > 0

  return (
    <>
      {/* Filter / toolbar bar */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-1.5 border-b border-citrus-border dark:border-citrus-night-border">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-citrus-muted dark:text-citrus-night-muted" />
          <input
            value={globalFilter}
            onChange={(e) => setGlobalFilter(e.target.value)}
            placeholder="Search all columns…"
            title="Matches any text in the row — indicator, kind, status, and every field"
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
          <button
            onClick={() => { setGlobalFilter(''); setColumnFilters([]) }}
            className="text-[11px] text-citrus-muted hover:text-citrus-pink dark:text-citrus-night-muted"
          >
            Clear all
          </button>
        )}
        <div className="ml-auto flex items-center gap-2">
          {hasFilter && (
            <span className="text-[11px] font-mono text-citrus-muted dark:text-citrus-night-muted">
              {rows.length} of {indicators.length}
            </span>
          )}
          <button
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold border border-citrus-border text-citrus-dark hover:bg-citrus-sand/60 transition-colors disabled:opacity-40 dark:border-citrus-night-border dark:text-citrus-night-text dark:hover:bg-citrus-night-elev"
            onClick={() => setExportOpen(true)}
            disabled={selectedValues.length === 0}
            title={selectedValues.length === 0 ? 'Tick rows to export' : `Export ${selectedValues.length} ticked row(s) to CSV`}
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
        </div>
      </div>

      {/* Grid */}
      <div ref={gridRef} tabIndex={0} onKeyDown={onGridKeyDown} className="pane__text--out flex-1 min-h-0 overflow-auto px-2 py-2 outline-none">
        {indicators.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-citrus-muted dark:text-citrus-night-muted">
            No indicators yet — paste some above, or use “Send to Intel” from a notepad or workspace.
          </div>
        ) : rows.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-citrus-muted dark:text-citrus-night-muted">
            No results match the filter.
            <button
              onClick={() => { setGlobalFilter(''); setColumnFilters([]) }}
              className="rounded-md border border-citrus-border px-2 py-0.5 text-xs font-semibold hover:border-citrus-pink/40 hover:text-citrus-pink dark:border-citrus-night-border"
            >
              Clear filters
            </button>
          </div>
        ) : (
          <table className="text-xs border-collapse">
            <thead className="sticky top-0 z-10 bg-citrus-cream/90 backdrop-blur dark:bg-citrus-night/90">
              {/* Group row: provider buckets (draggable to reorder), empty over the leading cols. */}
              <tr className="text-left text-citrus-muted dark:text-citrus-night-muted">
                <th />
                <th />
                <th rowSpan={2} className="px-2 py-1 font-semibold align-bottom cursor-pointer select-none hover:text-citrus-pink" onClick={() => table.getColumn('value')?.toggleSorting()}>
                  Indicator{sortArrow('value')}
                  {colDots('value')}
                </th>
                <th rowSpan={2} className="px-2 py-1 font-semibold align-bottom cursor-pointer select-none hover:text-citrus-pink" onClick={() => table.getColumn('kind')?.toggleSorting()}>
                  Kind{sortArrow('kind')}
                  {colDots('kind')}
                </th>
                {providerIds.map((pid) => (
                  <th
                    key={pid}
                    colSpan={2 + fieldsByProvider[pid].length}
                    draggable
                    onDragStart={() => setDragP(pid)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => { if (dragP) reorderProviders(dragP, pid); setDragP(null) }}
                    onDragEnd={() => setDragP(null)}
                    title="Drag to reorder this bucket"
                    className={`px-2 py-1 font-bold text-center text-citrus-pink border-l-[3px] border-citrus-pink/50 dark:border-citrus-pink/40 cursor-move ${dragP === pid ? 'opacity-40' : ''}`}
                  >
                    {providerName(pid)}
                  </th>
                ))}
              </tr>
              {/* Leaf row: select-all, #, then each provider's Status / fields / Source. */}
              <tr className="text-left text-citrus-muted dark:text-citrus-night-muted">
                <th className="px-2 py-1">
                  <input ref={headerBoxRef} type="checkbox" checked={table.getIsAllRowsSelected()} onChange={table.getToggleAllRowsSelectedHandler()} />
                </th>
                <th className="px-2 py-1 text-right font-semibold">#</th>
                {leaves.filter((l) => l.ckind !== 'indicator' && l.ckind !== 'kind').map(leafHeader)}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => {
                const rr = row.original
                const isSel = row.getIsSelected()
                const isHi = highlighted.has(rr.value)
                return (
                  <tr
                    key={rr.value}
                    className={`cursor-pointer select-none border-t border-citrus-border/60 dark:border-citrus-night-border/60 hover:bg-citrus-sand/30 dark:hover:bg-citrus-night-elev/40 ${
                      isHi
                        ? 'bg-citrus-pink-light/60 dark:bg-citrus-night-elev/80'
                        : isSel
                          ? 'bg-citrus-pink-light/20 dark:bg-citrus-night-elev/40'
                          : i % 2 === 1
                            ? 'bg-citrus-sand/15 dark:bg-citrus-night-card/30'
                            : ''
                    }`}
                    onMouseDown={(e) => { if (e.button === 0) beginRow(i, rr.value) }}
                    onMouseEnter={() => enterRow(i)}
                    onContextMenu={(e) => openMenu(e, rr.value)}
                  >
                    <td className="px-2 py-1">
                      <input type="checkbox" checked={isSel} onMouseDown={(e) => e.stopPropagation()} onChange={row.getToggleSelectedHandler()} />
                    </td>
                    <td className="px-2 py-1 text-right font-mono tabular-nums text-citrus-muted/70 dark:text-citrus-night-muted/70">{i + 1}</td>
                    <ValueCell text={rr.value} wrap={wrap} mono />
                    <td className="px-2 py-1 font-mono text-citrus-muted dark:text-citrus-night-muted">{rr.kind}</td>
                    {providerIds.map((pid) => {
                      const r = rr.byP[pid]
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

      {colMenu && (
        <ColMenu
          label={labelFor(colMenu.colId)}
          distinct={distinctFor(colMenu.colId)}
          current={(table.getColumn(colMenu.colId)?.getFilterValue() as string[]) ?? []}
          x={colMenu.x}
          y={colMenu.y}
          onApply={(vals) => table.getColumn(colMenu.colId)?.setFilterValue(vals.length ? vals : undefined)}
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
            onClick={() => { void navigator.clipboard.writeText(buildCsv(menu.targets)); setMenu(null) }}
          >
            <Copy className="w-3.5 h-3.5 shrink-0 text-citrus-pink" />
            Copy as CSV
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={() => setExportOpen(false)}>
          <div
            className="w-[22rem] max-w-[90vw] rounded-xl border border-citrus-border bg-citrus-card p-5 shadow-lg dark:border-citrus-night-border dark:bg-citrus-night-card"
            onClick={(e) => e.stopPropagation()}
          >
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
