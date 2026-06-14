import { useEffect, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { CsvDoc } from '../../state/documents'
import type { CsvColumn, CsvFilter, CsvSort } from '../../state/csvTypes'
import { useCsvQuery } from '../../hooks/useCsvQuery'
import { VirtualGrid } from './VirtualGrid'
import { FilterBar } from './FilterBar'
import { SearchBar } from './SearchBar'
import { ColumnMenu } from './ColumnMenu'
import { DistinctPanel } from './DistinctPanel'
import { CellPopout } from './CellPopout'

const SEARCH_DEBOUNCE_MS = 250

/** Heuristic: do the currently-loaded cells of a column look numeric? (drives sort mode) */
function looksNumeric(rows: string[][], colIdx: number): boolean {
  let seen = 0
  for (const r of rows) {
    const v = r[colIdx]
    if (v == null || v === '') continue
    if (!/^-?\d+(\.\d+)?$/.test(v.trim())) return false
    if (++seen >= 20) break
  }
  return seen > 0
}

export function CsvViewer({
  doc,
  onPivot
}: {
  doc: CsvDoc
  onPivot: (values: string[], label: string) => void
}): JSX.Element {
  const [sort, setSort] = useState<CsvSort | undefined>()
  const [filters, setFilters] = useState<CsvFilter[]>([])
  const [menu, setMenu] = useState<{ col: CsvColumn; anchor: { left: number; bottom: number } } | null>(null)
  const [popout, setPopout] = useState<{ label: string; value: string } | null>(null)
  // The column whose distinct values are shown in the side panel (null = panel closed).
  const [distinctCol, setDistinctCol] = useState<CsvColumn | null>(null)
  // `searchInput` is what the user types; `search` is the debounced term that drives the
  // query — so a multi-million-row LIKE scan only runs once typing settles.
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  useEffect(() => {
    const term = searchInput.trim()
    if (term === search) return
    const t = setTimeout(() => setSearch(term), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [searchInput, search])

  const { rows, baseOffset, total, loading, error, ensureRange } = useCsvQuery(
    doc.tabId,
    sort,
    filters,
    search
  )

  const colIndex = useMemo(
    () => new Map(doc.columns.map((c, i) => [c.name, i] as const)),
    [doc.columns]
  )

  function toggleSort(col: string): void {
    setSort((s) => {
      if (s?.col !== col) return { col, dir: 'asc', numeric: looksNumeric(rows, colIndex.get(col) ?? 0) }
      if (s.dir === 'asc') return { ...s, dir: 'desc' }
      return undefined // third click clears the sort
    })
  }

  function addFilter(f: CsvFilter): void {
    setFilters((fs) => [
      ...fs.filter((x) => !(x.col === f.col && x.op === f.op && x.op !== 'in' && f.op !== 'in' && x.value === f.value)),
      f
    ])
  }
  function removeFilter(i: number): void {
    setFilters((fs) => fs.filter((_, j) => j !== i))
  }

  // Apply a column's multi-select as ONE `in` filter: replace any existing `in` filter for
  // that column (so 3 chosen IPs are a single 3-value chip, not three chips); empty = remove.
  function applyInFilter(col: string, values: string[]): void {
    setFilters((fs) => {
      const without = fs.filter((f) => !(f.op === 'in' && f.col === col))
      return values.length > 0 ? [...without, { col, op: 'in', values }] : without
    })
  }

  // Values currently selected for a column's `in` filter (pre-checks the Filter submenu).
  function inValuesFor(col: string): string[] {
    const f = filters.find((x) => x.op === 'in' && x.col === col)
    return f && f.op === 'in' ? f.values : []
  }

  return (
    <div className="csv-viewer flex flex-col flex-1 min-h-0 bg-citrus-card dark:bg-citrus-night-card">
      <div className="flex items-center gap-3 px-3 py-2 text-xs border-b border-citrus-border dark:border-citrus-night-border">
        <span className="font-bold text-citrus-dark dark:text-citrus-night-text truncate max-w-[280px]">
          {doc.sourceName}
        </span>
        <span className="text-citrus-muted dark:text-citrus-night-muted font-mono">
          {doc.columns.length} cols · {total.toLocaleString()} rows
          {(filters.length > 0 || search !== '') && ` (of ${doc.rowCount.toLocaleString()})`}
        </span>
        {loading && <Loader2 className="w-3.5 h-3.5 animate-spin text-citrus-pink" />}
        {error && <span className="text-citrus-pink-hover truncate">{error}</span>}
      </div>

      <SearchBar
        value={searchInput}
        active={search !== ''}
        matches={total}
        loading={loading && search !== ''}
        onChange={setSearchInput}
        onClear={() => {
          setSearchInput('')
          setSearch('')
        }}
      />

      <FilterBar columns={doc.columns} filters={filters} onAdd={addFilter} onRemove={removeFilter} />

      <div className="flex flex-1 min-h-0">
        <VirtualGrid
          columns={doc.columns}
          rows={rows}
          baseOffset={baseOffset}
          total={total}
          sort={sort}
          resetKey={`${JSON.stringify(sort)}|${JSON.stringify(filters)}|${search}`}
          onToggleSort={toggleSort}
          onOpenColumnMenu={(col, anchor) => setMenu({ col, anchor })}
          onCellOpen={(value, label) => setPopout({ value, label })}
          getLongest={(colName) => window.api.csv.longest(doc.tabId, colName)}
          ensureRange={ensureRange}
        />
        {distinctCol && (
          <DistinctPanel
            doc={doc}
            col={distinctCol}
            filters={filters}
            onClose={() => setDistinctCol(null)}
            onPivot={onPivot}
          />
        )}
      </div>

      {menu && (
        <ColumnMenu
          doc={doc}
          col={menu.col}
          // The submenu lists values available under the OTHER filters, so the column's own
          // `in` selection can be freely changed.
          filters={filters.filter((f) => !(f.op === 'in' && f.col === menu.col.name))}
          currentValues={inValuesFor(menu.col.name)}
          anchor={menu.anchor}
          onClose={() => setMenu(null)}
          onShowDistinct={(col) => setDistinctCol(col)}
          onApplyInFilter={applyInFilter}
        />
      )}
      {popout && <CellPopout label={popout.label} value={popout.value} onClose={() => setPopout(null)} />}
    </div>
  )
}
