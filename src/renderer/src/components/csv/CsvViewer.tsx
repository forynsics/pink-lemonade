import { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { ChevronDown, Download, Loader2, Tags } from 'lucide-react'
import type { CsvColumn, CsvFilter, CsvSort } from '../../state/csvTypes'
import { TAG_DEFS, type TagId } from '../../state/tags'

/** Per-source tag rollup the viewer reports up so the sidebar can show + filter by tag. */
export interface TagSummary {
  counts: Partial<Record<TagId, number>>
  /** Tags currently in the OR filter set (empty = no tag filter). */
  activeTags: TagId[]
}
/** Imperative surface the sidebar drives (the active source's tag-filter toggles). */
export interface CsvViewerHandle {
  toggleTagFilter: (tag: TagId) => void
  clearTagFilter: () => void
}

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
import { classifyIndicator } from '../../tools/ioc/classify'
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
  onReorderColumns,
  apiRef,
  onTagSummary,
  onSendToEnrichment,
  sendIntelLabel = 'Intel'
}: {
  doc: CsvViewSource
  onPivot: (values: string[], label: string) => void
  onReorderColumns: (from: number, to: number) => void
  /** Set on the ACTIVE source only — lets the sidebar drive this source's tag filter. */
  apiRef?: React.Ref<CsvViewerHandle>
  /** Set on the ACTIVE source only — reports tag counts + the active tag filter to the sidebar. */
  onTagSummary?: (s: TagSummary | null) => void
  /** Send a cell value / a column's distinct values to this workspace's intel tab. */
  onSendToEnrichment?: (values: string[]) => void
  /** Label for the send-to-intel action ("Global Intel" or "Workspace Intel"). */
  sendIntelLabel?: string
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

  // When tags change while a "show only tagged X" filter is active, the cached filtered view goes
  // stale; bump this to force a re-query/re-count. Tracked via a ref so applyTag stays stable.
  const [tagRev, setTagRev] = useState(0)
  const hasTagFilterRef = useRef(false)

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
      if (hasTagFilterRef.current) setTagRev((r) => r + 1) // refresh the filtered view
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

  // Bulk-tag (or clear) every row matching the current filters + search — reaches the whole match
  // set, not just the loaded window. Reloads the full tag map afterward (many rows changed).
  const bulkTag = useCallback(
    async (tag: TagId | null) => {
      if (!taggable) return
      await window.api.csv.wsTagByFilter(wsId, sourceId, filters, search, tag)
      const rows = await window.api.csv.wsTagList(wsId, sourceId)
      setTags(new Map(rows.map((r) => [r.rid, r.tag])))
      if (hasTagFilterRef.current) setTagRev((r) => r + 1)
    },
    [taggable, wsId, sourceId, filters, search]
  )
  const [bulkOpen, setBulkOpen] = useState(false)

  // Export the whole current view (all rows under the active filters/search/sort) to a CSV file.
  // The confirm dialog shows the live match count; the worker streams every matching row to the
  // chosen path so the export covers the full result set, not just the loaded window.
  const [exportOpen, setExportOpen] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportDone, setExportDone] = useState<{ rows: number; path: string } | null>(null)
  async function exportCsv(): Promise<void> {
    setExportOpen(false)
    setExporting(true)
    setExportDone(null)
    try {
      const base = doc.sourceName.replace(/\.(csv|tsv|txt)$/i, '')
      const name = `${base}${hasPredicate ? '-filtered' : ''}.csv`
      const res = await window.api.csv.export(doc.tabId, name, { filters, search, sort })
      if (!('canceled' in res)) setExportDone({ rows: res.rows, path: res.path })
    } finally {
      setExporting(false)
    }
  }

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
    search,
    tagRev
  )

  // "Keep your spot" on a ± time pivot: remember the anchor row's rowid + the view it produced, then
  // once that view's filter index is built (count done), re-center the grid on the anchor. wasCounting
  // gates against firing on the stale (pre-count) render right after the filter changes.
  const pendingAnchorRef = useRef<{ rid: number; key: string } | null>(null)
  const wasCountingRef = useRef(false)
  // The pivot anchor's rowid — its row keeps a persistent pink ring + pin so you can always find
  // where you pivoted from. Cleared once no ± (timearound) filter is active.
  const [anchorRid, setAnchorRid] = useState<number | null>(null)
  useEffect(() => {
    if (!filters.some((f) => f.op === 'timearound')) setAnchorRid(null)
  }, [filters])
  useEffect(() => {
    if (counting) wasCountingRef.current = true
    const p = pendingAnchorRef.current
    if (!p || p.key !== JSON.stringify({ filters, search })) return
    if (counting || !wasCountingRef.current) return // index still building / count not started yet
    pendingAnchorRef.current = null
    wasCountingRef.current = false
    if (sort) return // unsorted pivot view only (the filter index is in rowid = display order)
    void window.api.csv.locate(doc.tabId, p.rid, filters, search).then((idx) => {
      if (idx >= 0) gridRef.current?.scrollToRow(idx)
    })
  }, [filters, search, counting, sort, doc.tabId])

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

  // Toggle a tag in the "show only rows tagged …" set (from the sidebar Tags facets). Tags OR
  // together, so you can show e.g. Malicious + Suspicious at once. Removing the last tag drops the
  // filter entirely.
  const toggleTagFilter = useCallback((tag: TagId): void => {
    setFilters((fs) => {
      const cur = fs.find((f) => f.op === 'tag')
      const curTags = cur && cur.op === 'tag' ? cur.tags : []
      const nextTags = curTags.includes(tag) ? curTags.filter((t) => t !== tag) : [...curTags, tag]
      const without = fs.filter((f) => f.op !== 'tag')
      return nextTags.length > 0 ? [...without, { op: 'tag', tags: nextTags }] : without
    })
  }, [])
  const clearTagFilter = useCallback((): void => {
    setFilters((fs) => fs.filter((f) => f.op !== 'tag'))
  }, [])
  const activeTagFilter = filters.find((f) => f.op === 'tag')
  const activeTags = (activeTagFilter?.op === 'tag' ? activeTagFilter.tags : []) as TagId[]
  hasTagFilterRef.current = activeTags.length > 0

  // The active source exposes its tag-filter controls and reports its tag rollup to the sidebar.
  useImperativeHandle(apiRef, () => ({ toggleTagFilter, clearTagFilter }), [toggleTagFilter, clearTagFilter])
  const activeTagsKey = activeTags.join(',')
  // The rollup must reflect the *view* predicate (column filters + search) but NOT the tag filter —
  // a tag facet shouldn't zero out its siblings, so you can still see and switch to other tags.
  const hasViewPredicate = filters.some((f) => f.op !== 'tag') || search !== ''
  useEffect(() => {
    if (!onTagSummary) return
    if (!taggable) {
      onTagSummary(null)
      return
    }
    const active = activeTagsKey ? (activeTagsKey.split(',') as TagId[]) : []
    // No view predicate → the whole-source map is already the right answer; count it in memory
    // (instant, no flicker, no IPC round-trip).
    if (!hasViewPredicate) {
      const counts: Partial<Record<TagId, number>> = {}
      for (const t of tags.values()) counts[t as TagId] = (counts[t as TagId] ?? 0) + 1
      onTagSummary({ counts, activeTags: active })
      return
    }
    // A filter/search is active: count tagged rows that survive it, in SQL. The worker handles
    // messages FIFO, so a preceding (unawaited) tag write is already applied when this runs.
    let live = true
    void window.api.csv.tagCounts(doc.tabId, filters, search).then((rows) => {
      if (!live) return
      const counts: Partial<Record<TagId, number>> = {}
      for (const r of rows) counts[r.tag as TagId] = r.cnt
      onTagSummary({ counts, activeTags: active })
    })
    return () => {
      live = false
    }
  }, [onTagSummary, taggable, tags, activeTagsKey, hasViewPredicate, filters, search, doc.tabId, tagRev])

  // Filter the whole CSV to rows within ±deltaSec of a time cell (one timearound filter per col).
  // Arm the pivot anchor so the grid re-centers on this row once the filtered view is ready.
  function applyTimeAround(cell: CellRef, deltaSec: number): void {
    if (!cell.tkind) return
    const tkind = cell.tkind
    const next: CsvFilter[] = [
      ...filters.filter((f) => !(f.op === 'timearound' && f.col === cell.colName)),
      { col: cell.colName, op: 'timearound', value: cell.value, tkind, deltaSec }
    ]
    setFilters(next)
    if (cell.rid != null) {
      pendingAnchorRef.current = { rid: cell.rid, key: JSON.stringify({ filters: next, search }) }
      wasCountingRef.current = false
      setAnchorRid(cell.rid)
    }
  }

  const hasPredicate = filters.length > 0 || search !== ''

  return (
    <div className="csv-viewer flex flex-col flex-1 min-w-0 min-h-0 bg-citrus-card dark:bg-citrus-night-card">
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

        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => setExportOpen(true)}
            disabled={exporting}
            className="inline-flex items-center gap-1 rounded-md border border-citrus-border px-1.5 py-0.5 text-[11px] font-semibold text-citrus-dark hover:border-citrus-pink/40 hover:text-citrus-pink disabled:opacity-60 dark:border-citrus-night-border dark:text-citrus-night-text"
            title={
              hasPredicate
                ? `Export the ${total.toLocaleString()} filtered row(s) to a CSV file`
                : 'Export all rows to a CSV file'
            }
          >
            {exporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
            Export CSV
          </button>
        {taggable && hasPredicate && (
          <div className="relative">
            <button
              onClick={() => setBulkOpen((o) => !o)}
              className="inline-flex items-center gap-1 rounded-md border border-citrus-border px-1.5 py-0.5 text-[11px] font-semibold text-citrus-dark hover:border-citrus-pink/40 hover:text-citrus-pink dark:border-citrus-night-border dark:text-citrus-night-text"
              title="Tag every row matching the current filters/search"
            >
              <Tags className="w-3.5 h-3.5" />
              Tag {total.toLocaleString()}
              {counting ? '+' : ''} matching
              <ChevronDown className="w-3 h-3" />
            </button>
            {bulkOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setBulkOpen(false)} />
                <div className="absolute left-0 top-full z-50 mt-1 flex w-44 flex-col rounded-lg border border-citrus-border bg-citrus-card py-1 shadow-lg dark:border-citrus-night-border dark:bg-citrus-night-card">
                  {TAG_DEFS.map((d) => (
                    <button
                      key={d.id}
                      onClick={() => {
                        void bulkTag(d.id)
                        setBulkOpen(false)
                      }}
                      className="flex items-center gap-2 px-3 py-1.5 text-left text-xs text-citrus-dark hover:bg-citrus-pink-light/60 dark:text-citrus-night-text dark:hover:bg-citrus-night-elev"
                    >
                      <span className={`inline-block w-3 h-3 rounded-sm ${d.dot}`} />
                      {d.label}
                    </button>
                  ))}
                  <button
                    onClick={() => {
                      void bulkTag(null)
                      setBulkOpen(false)
                    }}
                    className="mt-0.5 flex items-center gap-2 border-t border-citrus-border/60 px-3 py-1.5 text-left text-xs text-citrus-muted hover:bg-citrus-pink-light/60 dark:border-citrus-night-border/60 dark:text-citrus-night-muted dark:hover:bg-citrus-night-elev"
                  >
                    Clear tags on matching
                  </button>
                </div>
              </>
            )}
          </div>
        )}
        </div>
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

      <div className="flex flex-1 min-w-0 min-h-0">
        <VirtualGrid
          columns={doc.columns}
          rows={rows}
          rids={rids}
          tags={taggable ? tags : undefined}
          anchorRid={anchorRid ?? undefined}
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
            onSendToEnrichment={onSendToEnrichment}
            sendIntelLabel={sendIntelLabel}
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
          onSend={
            onSendToEnrichment && classifyIndicator(cellMenu.cell.value)
              ? () => onSendToEnrichment([cellMenu.cell.value])
              : undefined
          }
          sendLabel={sendIntelLabel}
          onClose={() => setCellMenu(null)}
        />
      )}

      {/* Export-to-CSV confirmation — shows how many events (the live filtered count) will be written. */}
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
              Export <strong className="text-citrus-dark dark:text-citrus-night-text">{total.toLocaleString()}</strong>
              {counting ? '+' : ''} {total === 1 ? 'event' : 'events'} to a CSV file.
              {hasPredicate ? ' (the current filtered view)' : ''}
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

      {/* Brief confirmation that the file was written (auto-dismissed by the user). */}
      {exportDone && (
        <div className="fixed bottom-4 right-4 z-50 flex items-center gap-2 rounded-lg border border-citrus-border bg-citrus-card px-3 py-2 text-xs shadow-lg dark:border-citrus-night-border dark:bg-citrus-night-card">
          <Download className="w-3.5 h-3.5 text-citrus-pink shrink-0" />
          <span className="text-citrus-dark dark:text-citrus-night-text">
            Exported {exportDone.rows.toLocaleString()} {exportDone.rows === 1 ? 'row' : 'rows'} →{' '}
            <span className="font-mono text-citrus-muted dark:text-citrus-night-muted">{exportDone.path}</span>
          </span>
          <button
            onClick={() => setExportDone(null)}
            className="ml-1 text-citrus-muted hover:text-citrus-pink dark:text-citrus-night-muted"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  )
}
