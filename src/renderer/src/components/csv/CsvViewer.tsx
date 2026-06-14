import { useCallback, useEffect, useRef, useState } from 'react'
import { Database, Loader2 } from 'lucide-react'
import type { CsvColumn, CsvFilter, CsvSort } from '../../state/csvTypes'
import { TAG_DEFS, type TagId } from '../../state/tags'

/** What the grid needs to render a source — satisfied by a workspace source view (or any table). */
export interface CsvViewSource {
  tabId: string // query key: a source key `<wsId>:<sourceId>`
  sourceName: string
  columns: CsvColumn[]
  rowCount: number
  dbPath: string
}
import { cellTimeToEpoch } from '../../state/timeKind'
import { useCsvQuery } from '../../hooks/useCsvQuery'
import { VirtualGrid, type CellRef, type VirtualGridHandle } from './VirtualGrid'
import { CellContextMenu } from './CellContextMenu'
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
  onPivot,
  onReorderColumns
}: {
  doc: CsvViewSource
  onPivot: (values: string[], label: string) => void
  onReorderColumns: (from: number, to: number) => void
}): JSX.Element {
  const [sort, setSort] = useState<CsvSort | undefined>()
  const [filters, setFilters] = useState<CsvFilter[]>([])
  const [menu, setMenu] = useState<{
    col: CsvColumn
    anchor: { left: number; bottom: number }
    showFilter?: boolean
  } | null>(null)
  const [popout, setPopout] = useState<{ label: string; value: string } | null>(null)
  // The column whose distinct values are shown in the side panel (null = panel closed).
  const [distinctCol, setDistinctCol] = useState<CsvColumn | null>(null)
  // Right-clicked cell (or a clicked ± chip) → the cell menu at the cursor. `tagRids` are the rows
  // the Tag-as action applies to (the clicked row, or the whole selection when clicked inside it).
  const [cellMenu, setCellMenu] = useState<{
    cell: CellRef
    at: { x: number; y: number }
    defaultMinutes?: number
    tagRids?: number[]
  } | null>(null)

  // Row tags for this source, keyed by positional rowid. Tagging only applies to workspace sources
  // (tabId === `<wsId>:<sourceId>`); a legacy single-file tab has no ':' and stays untagged.
  const [wsId, sidStr] = doc.tabId.split(':')
  const sourceId = Number(sidStr)
  const taggable = sidStr !== undefined && Number.isInteger(sourceId)
  const [tags, setTags] = useState<Map<number, string>>(new Map())
  useEffect(() => {
    if (!taggable) {
      setTags(new Map())
      return
    }
    let live = true
    void window.api.csv.wsTagList(wsId, sourceId).then((rows) => {
      if (live) setTags(new Map(rows.map((r) => [r.rid, r.tag])))
    })
    return () => {
      live = false
    }
  }, [doc.tabId, taggable, wsId, sourceId])

  // Set or clear the tag on a set of rows: persist, then update the local map optimistically.
  const applyTag = useCallback(
    (rids: number[], tag: TagId | null) => {
      if (!taggable || rids.length === 0) return
      void window.api.csv.wsTagSet(wsId, sourceId, rids, tag)
      setTags((prev) => {
        const next = new Map(prev)
        for (const rid of rids) {
          if (tag == null) next.delete(rid)
          else next.set(rid, tag)
        }
        return next
      })
    },
    [taggable, wsId, sourceId]
  )
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

  // Enter in the search box steps through matches. When a search is active the grid is already
  // filtered to matches, so "next match" is simply the next row (0..total-1). `matchIndex` is the
  // absolute row index of the focused match (-1 = not yet stepped); it resets when the query changes.
  const gridRef = useRef<VirtualGridHandle>(null)
  const [matchIndex, setMatchIndex] = useState(-1)
  useEffect(() => {
    setMatchIndex(-1)
  }, [search, filters, sort])
  function stepMatch(dir: 1 | -1): void {
    if (total <= 0) return
    setMatchIndex((cur) => {
      const next = cur < 0 ? (dir === 1 ? 0 : total - 1) : (cur + dir + total) % total
      gridRef.current?.scrollToRow(next)
      return next
    })
  }

  const { rows, rids, baseOffset, total, counting, loading, error, ensureRange } = useCsvQuery(
    doc.tabId,
    doc.rowCount,
    sort,
    filters,
    search
  )

  function toggleSort(col: string): void {
    setSort((s) => {
      // Rows arrive in original column order; index by the name's numeric suffix, not display pos.
      if (s?.col !== col) return { col, dir: 'asc', numeric: looksNumeric(rows, Number(col.slice(1))) }
      if (s.dir === 'asc') return { ...s, dir: 'desc' }
      return undefined // third click clears the sort
    })
  }

  function addFilter(f: CsvFilter): void {
    setFilters((fs) => {
      // De-dupe only the single-value eq/like/neq/nlike kinds; the rest just append.
      if (f.op === 'eq' || f.op === 'like' || f.op === 'neq' || f.op === 'nlike') {
        const dup = (x: CsvFilter): boolean =>
          (x.op === 'eq' || x.op === 'like' || x.op === 'neq' || x.op === 'nlike') &&
          x.col === f.col &&
          x.op === f.op &&
          x.value === f.value
        return [...fs.filter((x) => !dup(x)), f]
      }
      return [...fs, f]
    })
  }
  function removeFilter(i: number): void {
    setFilters((fs) => fs.filter((_, j) => j !== i))
  }
  function updateFilter(index: number, f: CsvFilter): void {
    setFilters((fs) => fs.map((x, j) => (j === index ? f : x)))
  }

  // Right-click "Filter to value" / "Exclude value" → an eq / neq filter on the cell's column.
  function applyValueFilter(cell: CellRef, exclude: boolean): void {
    addFilter({ col: cell.colName, op: exclude ? 'neq' : 'eq', value: cell.value })
  }

  // Clicking an `in` chip re-opens its column's multi-select submenu (pre-checked).
  function editInFilter(f: CsvFilter, at: { x: number; y: number }): void {
    if (f.op !== 'in') return
    const col = doc.columns.find((c) => c.name === f.col)
    if (col) setMenu({ col, anchor: { left: at.x, bottom: at.y }, showFilter: true })
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

  // Re-open the ± menu to edit an existing timearound chip (pre-filled with its current window).
  function editTimearound(f: CsvFilter, at: { x: number; y: number }): void {
    if (f.op !== 'timearound') return
    const original = doc.columns.find((c) => c.name === f.col)?.original ?? f.col
    setCellMenu({
      cell: { colName: f.col, original, value: f.value, tkind: f.tkind },
      at,
      defaultMinutes: Math.round(f.deltaSec / 60)
    })
  }

  // Right-click "On/after this" / "On/before this" → set a ≥ or ≤ bound from the cell's time,
  // merging into the column's single `timerange` chip (so ≥ then ≤ become one "between").
  function applyTimeBound(cell: CellRef, which: 'from' | 'to'): void {
    if (!cell.tkind) return
    const tkind = cell.tkind
    const epoch = cellTimeToEpoch(cell.value, tkind)
    if (epoch == null) return
    setFilters((fs) => {
      const existing = fs.find((f) => f.op === 'timerange' && f.col === cell.colName)
      const base = existing && existing.op === 'timerange' ? { from: existing.from, to: existing.to } : {}
      const without = fs.filter((f) => !(f.op === 'timerange' && f.col === cell.colName))
      return [...without, { col: cell.colName, op: 'timerange', tkind, ...base, [which]: epoch }]
    })
  }

  // Filter the whole CSV to rows within ±deltaSec of a time cell (one timearound filter per col).
  function applyTimeAround(cell: CellRef, deltaSec: number): void {
    if (!cell.tkind) return
    const tkind = cell.tkind
    setFilters((fs) => [
      ...fs.filter((f) => !(f.op === 'timearound' && f.col === cell.colName)),
      { col: cell.colName, op: 'timearound', value: cell.value, tkind, deltaSec }
    ])
  }

  // Per-category tag counts for the toolbar legend (derived from the local map).
  const tagCounts = new Map<string, number>()
  for (const t of tags.values()) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1)

  return (
    <div className="csv-viewer flex flex-col flex-1 min-h-0 bg-citrus-card dark:bg-citrus-night-card">
      <div className="flex items-center gap-3 px-3 py-2 text-xs border-b border-citrus-border dark:border-citrus-night-border">
        <span className="font-bold text-citrus-dark dark:text-citrus-night-text truncate max-w-[280px]">
          {doc.sourceName}
        </span>
        <span className="text-citrus-muted dark:text-citrus-night-muted font-mono">
          {doc.columns.length} cols · {total.toLocaleString()}
          {counting ? '+' : ''} rows
          {counting && ' (counting…)'}
          {(filters.length > 0 || search !== '') && ` (of ${doc.rowCount.toLocaleString()})`}
        </span>
        {(loading || counting) && <Loader2 className="w-3.5 h-3.5 animate-spin text-citrus-pink" />}
        {error && <span className="text-citrus-pink-hover truncate">{error}</span>}
        {taggable && tagCounts.size > 0 && (
          <span className="csv-tag-legend flex items-center gap-2">
            {TAG_DEFS.filter((d) => tagCounts.get(d.id)).map((d) => (
              <span key={d.id} className="flex items-center gap-1 text-[11px] text-citrus-muted dark:text-citrus-night-muted" title={d.label}>
                <span className={`inline-block w-2 h-2 rounded-sm ${d.dot}`} />
                {tagCounts.get(d.id)}
              </span>
            ))}
          </span>
        )}
        <span
          className="ml-auto inline-flex items-center gap-1 text-[10px] font-mono text-citrus-muted/70 dark:text-citrus-night-muted/70 truncate max-w-[360px]"
          title={`Loaded from ${doc.dbPath}`}
        >
          <Database className="w-3 h-3 shrink-0" />
          {doc.dbPath}
        </span>
      </div>

      <SearchBar
        value={searchInput}
        active={search !== ''}
        matches={total}
        counting={counting && search !== ''}
        position={matchIndex < 0 ? 0 : matchIndex + 1}
        loading={loading && search !== ''}
        onChange={setSearchInput}
        onClear={() => {
          setSearchInput('')
          setSearch('')
        }}
        onStep={stepMatch}
      />

      <FilterBar
        columns={doc.columns}
        filters={filters}
        onAdd={addFilter}
        onUpdate={updateFilter}
        onRemove={removeFilter}
        onEditTimearound={editTimearound}
        onEditIn={editInFilter}
      />

      <div className="flex flex-1 min-h-0">
        <VirtualGrid
          columns={doc.columns}
          rows={rows}
          rids={rids}
          tags={taggable ? tags : undefined}
          baseOffset={baseOffset}
          total={total}
          sort={sort}
          search={search}
          resetKey={`${JSON.stringify(sort)}|${JSON.stringify(filters)}|${search}`}
          onToggleSort={toggleSort}
          onOpenColumnMenu={(col, anchor) => setMenu({ col, anchor })}
          onCellOpen={(value, label) => setPopout({ value, label })}
          getLongest={(colName) => window.api.csv.longest(doc.tabId, colName)}
          onCellContext={(cell, at, ctxRids) => setCellMenu({ cell, at, tagRids: taggable ? ctxRids : undefined })}
          ensureRange={ensureRange}
          controllerRef={gridRef}
          onReorderColumns={onReorderColumns}
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
          initialShowFilter={menu.showFilter}
          onClose={() => setMenu(null)}
          onShowDistinct={(col) => setDistinctCol(col)}
          onApplyInFilter={applyInFilter}
        />
      )}
      {popout && <CellPopout label={popout.label} value={popout.value} onClose={() => setPopout(null)} />}
      {cellMenu && (
        <CellContextMenu
          cell={cellMenu.cell}
          at={cellMenu.at}
          defaultMinutes={cellMenu.defaultMinutes}
          tagRids={cellMenu.tagRids}
          currentTag={cellMenu.tagRids?.length === 1 ? tags.get(cellMenu.tagRids[0]) : undefined}
          onFilter={applyValueFilter}
          onPickTime={applyTimeAround}
          onPickBound={applyTimeBound}
          onTag={applyTag}
          onClose={() => setCellMenu(null)}
        />
      )}
    </div>
  )
}
