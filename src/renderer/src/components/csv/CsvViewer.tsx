import { useEffect, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { CsvDoc } from '../../state/documents'
import type { CsvColumn, CsvFilter, CsvSort } from '../../state/csvTypes'
import { useCsvQuery } from '../../hooks/useCsvQuery'
import { VirtualGrid } from './VirtualGrid'
import { FilterBar } from './FilterBar'
import { SearchBar } from './SearchBar'
import { ColumnDrilldown } from './ColumnDrilldown'

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
  const [drill, setDrill] = useState<CsvColumn | null>(null)
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
      ...fs.filter((x) => !(x.col === f.col && x.op === f.op && x.value === f.value)),
      f
    ])
  }
  function removeFilter(i: number): void {
    setFilters((fs) => fs.filter((_, j) => j !== i))
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
          onPickColumn={setDrill}
          ensureRange={ensureRange}
        />
        {drill && (
          <ColumnDrilldown
            doc={doc}
            col={drill}
            filters={filters}
            onClose={() => setDrill(null)}
            onPivot={onPivot}
            onAddFilter={addFilter}
          />
        )}
      </div>
    </div>
  )
}
