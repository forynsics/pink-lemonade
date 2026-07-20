import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { ChevronDown, Crosshair, Download, Loader2, Sparkles, Tags, Trash2 } from 'lucide-react'
import type { CsvColumn, CsvFilter, CsvSort } from '../../state/csvTypes'
import { TAG_DEFS, type TagId } from '../../state/tags'

/** Per-source tag rollup the viewer reports up so the sidebar can show + filter by tag. */
export interface TagSummary {
  counts: Partial<Record<TagId, number>>
  /** Tags currently in the include (OR) filter set — left-click facets (empty = none). */
  activeTags: TagId[]
  /** Tags currently excluded — right-click facets (empty = none). */
  excludedTags: TagId[]
}
/** Imperative surface the sidebar drives (the active source's tag-filter toggles). */
export interface CsvViewerHandle {
  toggleTagFilter: (tag: TagId) => void
  excludeTagFilter: (tag: TagId) => void
  clearTagFilter: () => void
  /** Reload tag markers from disk — used after the AI agent tags rows in this source. */
  reloadTags: () => void
}

/** What the grid needs to render a source — satisfied by a workspace source view (or any table). */
export interface CsvViewSource {
  tabId: string // query key: a source key `<wsId>:<sourceId>`
  sourceName: string
  /** The source's group (host/system it came from), shown ahead of the filename so you can tell
   *  WHICH machine's copy of a shared filename you are looking at. Null when ungrouped. */
  group?: string | null
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
import { ColumnPicker } from './ColumnPicker'
import { DistinctPanel } from './DistinctPanel'
import { SweepDialog, type SweepSource } from './SweepDialog'
import { classifyIndicator } from '../../tools/ioc/classify'
import { isInternalTimelineColumn, TIMELINE_PIVOT_SOURCE_COL, TIMELINE_PIVOT_RIDS_COL } from '../../state/timeline'
import { CellPopout } from './CellPopout'
import { RowPopout, type RowField } from './RowPopout'
import { RecordEventDialog, type RecordEventSubmit } from './RecordEventDialog'
import { JsonExtractDialog } from './JsonExtractDialog'

const SEARCH_DEBOUNCE_MS = 250

/** Heuristic: do the currently-loaded cells of a column look numeric? (drives sort mode) */
// Prefer the flag decided at INGEST over sniffing the loaded page: a page-based guess makes a
// column sort numerically on one screen and alphabetically on the next. looksNumeric remains the
// fallback for workspaces created before the flag existed, which have no stored answer.
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
  searchTrailing,
  onReorderColumns,
  onColumnsExtracted,
  savedHidden,
  onHiddenColumns,
  pendingSweep,
  onConsumePendingSweep,
  pendingFocus,
  onConsumePendingFocus,
  onPivotEvidence,
  apiRef,
  onTagSummary,
  onEventRecorded,
  onSendToEnrichment,
  sendIntelLabel = 'Intel',
  intelDbPath,
  sweepSources,
  onSightingsChanged,
  onOpenSightings,
  sightingRefreshKey
}: {
  doc: CsvViewSource
  onPivot: (values: string[], label: string) => void
  /** Workspace-scoped controls (Constellation / Timeline / Investigation / IOC toggles) rendered at
   *  the trailing edge of the Search bar. Provided only for workspace sources. */
  searchTrailing?: React.ReactNode
  onReorderColumns: (from: number, to: number) => void
  /** Append columns just extracted from a JSON field to the live source (workspace sources only). */
  onColumnsExtracted?: (cols: CsvColumn[]) => void
  /** Persisted hidden-column names for this source (restored on mount). */
  savedHidden?: string[]
  /** Report the hidden-column set up so it persists on the workspace source. */
  onHiddenColumns?: (names: string[]) => void
  /** Set when an Intel-tab pivot targets THIS source — opens the Sweep dialog pre-filled. The
   *  `token` changes per pivot so the same indicators can be sent twice. */
  pendingSweep?: { values: string[]; token: number }
  /** Clear the pending pivot once consumed (so it doesn't re-open on the next render). */
  onConsumePendingSweep?: () => void
  /** Set when a pivot targets THIS source — focuses specific evidence rows (rids) or a value. */
  pendingFocus?: { rids?: number[]; token: number }
  onConsumePendingFocus?: () => void
  /** Pivot to a source's exact evidence rows — wired for the materialized Timeline source, whose rows
   *  carry a hidden (sourceId, rids) address. Double-clicking a row calls this. */
  onPivotEvidence?: (sourceId: number, rids: number[]) => void
  /** Set on the ACTIVE source only — lets the sidebar drive this source's tag filter. */
  apiRef?: React.Ref<CsvViewerHandle>
  /** Set on the ACTIVE source only — reports tag counts + the active tag filter to the sidebar. */
  onTagSummary?: (s: TagSummary | null) => void
  /** Called after the analyst records an event from selected rows, so the Constellation/Timeline reload. */
  onEventRecorded?: () => void
  /** Send a cell value / a column's distinct values to this workspace's intel tab. */
  onSendToEnrichment?: (values: string[]) => void
  /** Label for the send-to-intel action ("Global Intel" or "Workspace Intel"). */
  sendIntelLabel?: string
  /** This workspace's Intel DB path — enables the Sweep dialog's "Flagged" (VT-malicious) source. */
  intelDbPath?: string
  /** Every source in this workspace — lets the Sweep dialog fan out across more than this one file.
   *  Absent on legacy/non-workspace tabs (the dialog then falls back to just this source). */
  sweepSources?: SweepSource[]
  /** Bubbled whenever this source's sightings change (a sweep finished, or a row sighting cleared) so
   *  the workspace-wide Sightings view reloads. */
  onSightingsChanged?: () => void
  /** Open the workspace-wide Sightings results panel (the single Sightings surface, lives in App). */
  onOpenSightings?: () => void
  /** Bumped by App after a cross-source sighting change so this grid reloads its crosshair markers. */
  sightingRefreshKey?: number
}): JSX.Element {
  const [sort, setSort] = useState<CsvSort | undefined>()
  const [filters, setFilters] = useState<CsvFilter[]>([])
  const [menu, setMenu] = useState<{
    col: CsvColumn
    anchor: { left: number; bottom: number }
    showFilter?: boolean
  } | null>(null)
  const [popout, setPopout] = useState<{ label: string; value: string } | null>(null)
  const [rowPopout, setRowPopout] = useState<{ title: string; fields: RowField[] } | null>(null)
  // Selected rows pending "Record as event" (the analyst's own finding from these rows).
  const [recordEvt, setRecordEvt] = useState<{ rids: number[]; rows: string[][] } | null>(null)
  // The JSON column the analyst is extracting sub-fields from (opens JsonExtractDialog).
  const [extractCol, setExtractCol] = useState<CsvColumn | null>(null)
  // Visible columns = every column except the materialized Timeline's hidden pivot-address machinery
  // (`_sourceId`/`_rids`). Used for the grid, picker, filter bar, export, copy, and count so those
  // columns never surface; the raw row still carries them for the double-click pivot below.
  const displayColumns = useMemo(() => doc.columns.filter((c) => !isInternalTimelineColumn(c.original)), [doc.columns])
  // The raw c<n> indices of the pivot-address columns (materialized Timeline only), so a row click can
  // read (sourceId, rids) straight out of the source-order row.
  const pivotIdx = useMemo(() => {
    const s = doc.columns.find((c) => c.original === TIMELINE_PIVOT_SOURCE_COL)
    const r = doc.columns.find((c) => c.original === TIMELINE_PIVOT_RIDS_COL)
    return s && r ? { s: Number(s.name.slice(1)), r: Number(r.name.slice(1)) } : null
  }, [doc.columns])
  // Build label/value pairs for a full-row modal from a SOURCE-ORDER row (rows arrive as c0..cN),
  // mapped through the (possibly reordered) display columns by each column's stable `c<n>` index.
  const rowFields = (row: string[]): RowField[] =>
    displayColumns.map((col) => ({ label: col.original, value: row[Number(col.name.slice(1))] ?? '' }))
  // Columns the user has hidden, keyed by stable `c<n>` name (so reorder doesn't disturb them).
  // Pure display state — the query still selects every column; this only gates rendering. Seeded
  // from the persisted set and reported back up on change; pruned if the column set changes.
  const [hidden, setHidden] = useState<Set<string>>(() => new Set(savedHidden ?? []))
  // Persist the hidden set whenever it changes (skip the initial seed — already persisted).
  const onHiddenRef = useRef(onHiddenColumns)
  onHiddenRef.current = onHiddenColumns
  const hiddenMounted = useRef(false)
  useEffect(() => {
    if (!hiddenMounted.current) {
      hiddenMounted.current = true
      return
    }
    onHiddenRef.current?.([...hidden])
  }, [hidden])
  useEffect(() => {
    setHidden((prev) => {
      const valid = new Set(doc.columns.map((c) => c.name))
      const next = new Set([...prev].filter((n) => valid.has(n)))
      return next.size === prev.size ? prev : next
    })
  }, [doc.columns])
  const hideColumn = useCallback((col: CsvColumn): void => {
    setHidden((prev) => {
      if (prev.has(col.name)) return prev
      // Never hide the last visible column — the grid needs at least one.
      if (displayColumns.length - prev.size <= 1) return prev
      const next = new Set(prev)
      next.add(col.name)
      return next
    })
  }, [displayColumns.length])
  const toggleColumn = useCallback((name: string): void => {
    setHidden((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }, [])
  const showAllColumns = useCallback((): void => setHidden(new Set()), [])
  // The column whose distinct values are shown in the side panel (null = panel closed).
  const [distinctCol, setDistinctCol] = useState<CsvColumn | null>(null)
  // Right-clicked cell (or a clicked ± chip) → the cell menu at the cursor. `tagRids` are the rows
  // the Tag-as action applies to (the clicked row, or the whole selection when clicked inside it).
  const [cellMenu, setCellMenu] = useState<{
    cell: CellRef
    at: { x: number; y: number }
    defaultMinutes?: number
    tagRids?: number[]
    /** Full values (source column order) of the row(s) acted on — backs the "Copy row(s)" action. */
    rows?: string[][]
  } | null>(null)

  // Row tags for this source, keyed by positional rowid. Tagging only applies to workspace sources
  // (tabId === `<wsId>:<sourceId>`); a legacy single-file tab has no ':' and stays untagged.
  const [wsId, sidStr] = doc.tabId.split(':')
  const sourceId = Number(sidStr)
  const taggable = sidStr !== undefined && Number.isInteger(sourceId)

  // Record the selected rows as an analyst event (interpretation grounded in real rows). Columns are sent
  // in canonical c0..cN order, aligned with the source-order row arrays (the display order may differ).
  async function recordEventFromRows(payload: RecordEventSubmit): Promise<void> {
    if (!recordEvt || !taggable) return
    const columns = [...displayColumns]
      .sort((a, b) => Number(a.name.slice(1)) - Number(b.name.slice(1)))
      .map((c) => ({ name: c.name, original: c.original, time: c.time ?? null }))
    const base = { wsId, sourceId, sourceName: doc.sourceName, rids: recordEvt.rids, rows: recordEvt.rows, columns }
    if (payload.kind === 'existing') {
      // Attach to an existing event — label/etc. are the event's own; backend ignores these here.
      await window.api.csv.wsEventCreateFromRows({ ...base, label: '', description: null, technique: null, users: [], eventId: payload.eventId })
    } else {
      await window.api.csv.wsEventCreateFromRows({ ...base, label: payload.label, description: payload.description, technique: payload.technique, users: payload.users })
    }
    setRecordEvt(null)
    onEventRecorded?.()
  }

  // Extract scalar JSON sub-fields of `extractCol` into new grid columns on this source (in place —
  // rowids preserved). Lets the dialog surface a backend error by rejecting; closes only on success.
  async function extractJsonFields(fields: Array<{ path: string; displayName: string }>): Promise<void> {
    if (!extractCol || !taggable) return
    const cols = await window.api.csv.wsAddDerivedColumns(wsId, sourceId, extractCol.name, fields)
    onColumnsExtracted?.(cols)
    setExtractCol(null)
  }
  const [tags, setTags] = useState<Map<number, string>>(new Map())
  // AI-accountability marks (✨): rowid → the note the agent left. Its own dimension (separate
  // from intent tags), so the analyst can filter the grid to exactly what the agent flagged.
  const [aiMarks, setAiMarks] = useState<Map<number, string | null>>(new Map())
  const reloadTags = useCallback(async (): Promise<void> => {
    if (!taggable) {
      setTags(new Map())
      setAiMarks(new Map())
      return
    }
    const [tagRows, markRows] = await Promise.all([window.api.csv.wsTagList(wsId, sourceId), window.api.csv.wsAiMarkList(wsId, sourceId)])
    setTags(new Map(tagRows.map((r) => [r.rid, r.tag])))
    setAiMarks(new Map(markRows.map((r) => [r.rid, r.note])))
  }, [taggable, wsId, sourceId])
  useEffect(() => {
    let live = true
    void reloadTags().catch(() => {})
    return () => {
      live = false
      void live
    }
  }, [doc.tabId, reloadTags])

  // Intel-sweep sightings for this source: rowid → matched-indicator tooltip. Drives the grid's
  // crosshair marker + the "show only sightings" toggle. `sightingRev` bumps to reload after a sweep.
  const [sightings, setSightings] = useState<Map<number, string[]>>(new Map())
  const [sightingRev, setSightingRev] = useState(0)
  const [sweepOpen, setSweepOpen] = useState(false)
  // Seed text + a remount key for the Sweep dialog: the Intel-tab pivot opens it pre-filled, and the
  // key forces a fresh mount so a new pivot re-seeds even if the dialog was already open.
  const [sweepInitial, setSweepInitial] = useState('')
  const [sweepKey, setSweepKey] = useState(0)
  const openSweep = useCallback((initial: string): void => {
    setSweepInitial(initial)
    setSweepKey((k) => k + 1)
    setSweepOpen(true)
  }, [])
  // An Intel-tab pivot landed on this source → open the Sweep dialog pre-filled, then clear it.
  const pendingToken = pendingSweep?.token
  useEffect(() => {
    if (!pendingSweep) return
    openSweep(pendingSweep.values.join('\n'))
    onConsumePendingSweep?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingToken])
  useEffect(() => {
    if (!taggable) {
      setSightings(new Map())
      return
    }
    let live = true
    void window.api.csv.sightingList(wsId, sourceId).then((rows) => {
      if (!live) return
      const m = new Map<number, string[]>()
      for (const r of rows) {
        const arr = m.get(r.rid)
        if (arr) arr.push(r.indicator)
        else m.set(r.rid, [r.indicator])
      }
      setSightings(m)
    })
    return () => {
      live = false
    }
  }, [doc.tabId, taggable, wsId, sourceId, sightingRev, sightingRefreshKey])

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
      await reloadTags()
      if (hasTagFilterRef.current) setTagRev((r) => r + 1)
    },
    [taggable, wsId, sourceId, filters, search, reloadTags]
  )

  // Remove every AI ✨ mark from this source (a "reset the agent's marks" action). Two-click
  // confirm — a native confirm() can't be used in the sandboxed renderer.
  const [confirmClearMarks, setConfirmClearMarks] = useState(false)
  const clearAiMarks = useCallback(async (): Promise<void> => {
    if (!taggable) return
    await window.api.csv.wsAiMarkClear(wsId, sourceId)
    setFilters((prev) => prev.filter((f) => f.op !== 'aimark')) // drop the now-empty filter if active
    await reloadTags()
    setConfirmClearMarks(false)
  }, [taggable, wsId, sourceId, reloadTags])
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
      // Export the columns you can see, in the order you see them (visible-only, display order).
      const columns = displayColumns.filter((c) => !hidden.has(c.name)).map((c) => c.name)
      const res = await window.api.csv.export(doc.tabId, name, { filters, search, sort, columns })
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
      const numericFor = (id: string): boolean => {
        const meta = doc.columns.find((c) => c.name === id)
        return meta?.numeric ?? looksNumeric(rows, Number(id.slice(1)))
      }
      if (s?.col !== col) return { col, dir: 'asc', numeric: numericFor(col) }
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

  // Right-click "Copy row(s)" → the whole row(s) as tab-separated lines (one header + a line per
  // row), so it pastes cleanly into a spreadsheet, ticket, or note. Values are in source-column
  // order (all columns). Multi-row copy covers the loaded rows of the current selection.
  function copyRows(rows: string[][]): void {
    const header = displayColumns.map((c) => c.original).join('\t')
    const lines = rows.map((row) => displayColumns.map((_, i) => row[i] ?? '').join('\t'))
    void navigator.clipboard?.writeText([header, ...lines].join('\n'))
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

  // Tag facets, like the sightings panel: left-click includes (show only these tags, OR'd),
  // right-click excludes (hide these tags). Include and exclude are separate filter slots; a tag
  // sits in at most one. Removing the last tag from a slot drops that slot.
  const rebuildTags = (fs: CsvFilter[], incTags: string[], excTags: string[]): CsvFilter[] => {
    const out: CsvFilter[] = fs.filter((f) => f.op !== 'tag')
    if (incTags.length > 0) out.push({ op: 'tag', tags: incTags })
    if (excTags.length > 0) out.push({ op: 'tag', tags: excTags, exclude: true })
    return out
  }
  const toggleTagFilter = useCallback((tag: TagId): void => {
    setFilters((fs) => {
      const inc = fs.find((f) => f.op === 'tag' && !f.exclude)
      const incTags = inc?.op === 'tag' ? inc.tags : []
      const exc = fs.find((f) => f.op === 'tag' && f.exclude)
      const excTags = (exc?.op === 'tag' ? exc.tags : []).filter((t) => t !== tag)
      const nextInc = incTags.includes(tag) ? incTags.filter((t) => t !== tag) : [...incTags, tag]
      return rebuildTags(fs, nextInc, excTags)
    })
  }, [])
  const excludeTagFilter = useCallback((tag: TagId): void => {
    setFilters((fs) => {
      const inc = fs.find((f) => f.op === 'tag' && !f.exclude)
      const incTags = (inc?.op === 'tag' ? inc.tags : []).filter((t) => t !== tag)
      const exc = fs.find((f) => f.op === 'tag' && f.exclude)
      const excTags = exc?.op === 'tag' ? exc.tags : []
      const nextExc = excTags.includes(tag) ? excTags.filter((t) => t !== tag) : [...excTags, tag]
      return rebuildTags(fs, incTags, nextExc)
    })
  }, [])
  const clearTagFilter = useCallback((): void => {
    setFilters((fs) => fs.filter((f) => f.op !== 'tag'))
  }, [])
  const clearRowSighting = useCallback(
    async (rid: number): Promise<void> => {
      await window.api.csv.sightingClear(wsId, sourceId, { rid })
      setSightingRev((r) => r + 1)
      onSightingsChanged?.() // keep the workspace-wide Sightings panel in sync
    },
    [wsId, sourceId, onSightingsChanged]
  )
  const incTagFilter = filters.find((f) => f.op === 'tag' && !f.exclude)
  const excTagFilter = filters.find((f) => f.op === 'tag' && f.exclude)
  const activeTags = (incTagFilter?.op === 'tag' ? incTagFilter.tags : []) as TagId[]
  const excludedTags = (excTagFilter?.op === 'tag' ? excTagFilter.tags : []) as TagId[]
  hasTagFilterRef.current = activeTags.length > 0 || excludedTags.length > 0

  // Show EXACTLY a set of rows (a constellation event's evidence) — a rowid filter, not a keyword.
  const focusRids = useCallback((rids: number[]): void => {
    setSearchInput('')
    setSearch('')
    setFilters((prev) => [...prev.filter((f) => f.op !== 'rids'), { op: 'rids', rids }])
  }, [])
  // A constellation "jump to evidence" pivot landed on this source → focus its rows, then clear.
  const focusToken = pendingFocus?.token
  useEffect(() => {
    if (!pendingFocus) return
    if (pendingFocus.rids) focusRids(pendingFocus.rids)
    onConsumePendingFocus?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusToken])
  useImperativeHandle(
    apiRef,
    () => ({ toggleTagFilter, excludeTagFilter, clearTagFilter, reloadTags: () => void reloadTags() }),
    [toggleTagFilter, excludeTagFilter, clearTagFilter, reloadTags]
  )
  const activeTagsKey = `${activeTags.join(',')}|${excludedTags.join(',')}`
  // The rollup must reflect the *view* predicate (column filters + search) but NOT the tag filter —
  // a tag facet shouldn't zero out its siblings, so you can still see and switch to other tags.
  const hasViewPredicate = filters.some((f) => f.op !== 'tag') || search !== ''
  useEffect(() => {
    if (!onTagSummary) return
    if (!taggable) {
      onTagSummary(null)
      return
    }
    // No view predicate → the whole-source map is already the right answer; count it in memory
    // (instant, no flicker, no IPC round-trip).
    if (!hasViewPredicate) {
      const counts: Partial<Record<TagId, number>> = {}
      for (const t of tags.values()) counts[t as TagId] = (counts[t as TagId] ?? 0) + 1
      onTagSummary({ counts, activeTags, excludedTags })
      return
    }
    // A filter/search is active: count tagged rows that survive it, in SQL. The worker handles
    // messages FIFO, so a preceding (unawaited) tag write is already applied when this runs.
    let live = true
    void window.api.csv.tagCounts(doc.tabId, filters, search).then((rows) => {
      if (!live) return
      const counts: Partial<Record<TagId, number>> = {}
      for (const r of rows) counts[r.tag as TagId] = r.cnt
      onTagSummary({ counts, activeTags, excludedTags })
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
        {/* The host this artifact came from, ahead of the filename — different machines legitimately
            hold the SAME filename, so the name alone doesn't say which copy is on screen. */}
        {doc.group && (
          <span
            className="shrink-0 rounded border border-citrus-border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-citrus-muted dark:border-citrus-night-border dark:text-citrus-night-muted"
            title={`Host / group: ${doc.group}`}
          >
            {doc.group}
          </span>
        )}
        <span
          className="font-bold text-citrus-dark dark:text-citrus-night-text truncate max-w-[280px]"
          title={doc.group ? `${doc.group} / ${doc.sourceName}` : doc.sourceName}
        >
          {doc.sourceName}
        </span>
        <span className="text-citrus-muted dark:text-citrus-night-muted font-mono">
          {displayColumns.length} cols · {total.toLocaleString()}
          {counting ? '+' : ''} rows
          {counting && ' (counting…)'}
          {(filters.length > 0 || search !== '') && ` (of ${doc.rowCount.toLocaleString()})`}
        </span>
        {(loading || counting) && <Loader2 className="w-3.5 h-3.5 animate-spin text-citrus-pink" />}
        {error && <span className="text-citrus-pink-hover truncate">{error}</span>}

        <div className="ml-auto flex items-center gap-2">
          {taggable && (
            <button
              onClick={() => openSweep('')}
              className="inline-flex items-center gap-1 rounded-md border border-citrus-border px-1.5 py-0.5 text-[11px] font-semibold text-citrus-dark hover:border-red-500/40 hover:text-red-600 dark:border-citrus-night-border dark:text-citrus-night-text"
              title="Sweep this source for indicators"
            >
              <Crosshair className="w-3.5 h-3.5" />
              Intel Sweep
            </button>
          )}
          {taggable && sightings.size > 0 && onOpenSightings && (
            <button
              onClick={onOpenSightings}
              className="inline-flex items-center gap-1 rounded-md border border-citrus-border px-1.5 py-0.5 text-[11px] font-semibold text-citrus-dark transition-colors hover:border-red-500/40 hover:text-red-600 dark:border-citrus-night-border dark:text-citrus-night-text"
              title="Open workspace Sightings"
            >
              <Crosshair className="w-3.5 h-3.5" />
              {sightings.size.toLocaleString()} {sightings.size === 1 ? 'sighting' : 'sightings'}
            </button>
          )}
          {taggable && aiMarks.size > 0 && (
            <span className="inline-flex items-center">
              <button
                onClick={() => {
                  setConfirmClearMarks(false)
                  setFilters((prev) =>
                    prev.some((f) => f.op === 'aimark') ? prev.filter((f) => f.op !== 'aimark') : [...prev, { op: 'aimark' }]
                  )
                }}
                className={`inline-flex items-center gap-1 rounded-l-md border px-1.5 py-0.5 text-[11px] font-semibold transition-colors ${
                  filters.some((f) => f.op === 'aimark')
                    ? 'border-citrus-pink/50 bg-citrus-pink/10 text-citrus-pink'
                    : 'border-citrus-border text-citrus-dark hover:border-citrus-pink/40 hover:text-citrus-pink dark:border-citrus-night-border dark:text-citrus-night-text'
                }`}
                title="Filter to AI-marked rows"
              >
                <Sparkles className="w-3.5 h-3.5" />
                {aiMarks.size.toLocaleString()} AI-marked
              </button>
              {confirmClearMarks ? (
                <button
                  onClick={() => void clearAiMarks()}
                  className="inline-flex items-center gap-1 rounded-r-md border border-l-0 border-red-500/60 bg-red-500/10 px-1.5 py-0.5 text-[11px] font-semibold text-red-600 dark:border-red-400/60 dark:text-red-400"
                  title="Confirm — remove all AI marks"
                >
                  Clear all?
                </button>
              ) : (
                <button
                  onClick={() => setConfirmClearMarks(true)}
                  className="inline-flex items-center rounded-r-md border border-l-0 border-citrus-border px-1 py-0.5 text-citrus-muted hover:text-red-600 dark:border-citrus-night-border dark:text-citrus-night-muted"
                  title="Remove all AI marks"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </span>
          )}
          <ColumnPicker columns={displayColumns} hidden={hidden} onToggle={toggleColumn} onShowAll={showAllColumns} />
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
        trailing={searchTrailing}
      />

      <FilterBar
        columns={displayColumns}
        filters={filters}
        onAdd={addFilter}
        onUpdate={updateFilter}
        onRemove={removeFilter}
        onEditTimearound={editTimearound}
        onEditIn={editInFilter}
      />

      <div className="flex flex-1 min-w-0 min-h-0">
        <VirtualGrid
          columns={displayColumns}
          rows={rows}
          rids={rids}
          tags={taggable ? tags : undefined}
          aiMarks={taggable ? aiMarks : undefined}
          sightings={taggable ? sightings : undefined}
          hidden={hidden}
          anchorRid={anchorRid ?? undefined}
          baseOffset={baseOffset}
          total={total}
          sort={sort}
          search={search}
          resetKey={`${JSON.stringify(sort)}|${JSON.stringify(filters)}|${search}`}
          onToggleSort={toggleSort}
          onOpenColumnMenu={(col, anchor) => setMenu({ col, anchor })}
          onCellOpen={(value, label) => setPopout({ value, label })}
          onRowOpen={(fields, title) => setRowPopout({ fields, title })}
          onRowActivate={
            pivotIdx && onPivotEvidence
              ? (row) => {
                  const sid = Number(row[pivotIdx.s])
                  let evRids: number[] = []
                  try {
                    const parsed = JSON.parse(row[pivotIdx.r] || '[]')
                    if (Array.isArray(parsed)) evRids = parsed.filter((n): n is number => Number.isInteger(n))
                  } catch {
                    evRids = []
                  }
                  if (Number.isInteger(sid) && sid >= 0 && evRids.length) onPivotEvidence(sid, evRids)
                }
              : undefined
          }
          getLongest={(colName) => window.api.csv.longest(doc.tabId, colName)}
          onCellContext={(cell, at, ctxRids, rows) => setCellMenu({ cell, at, tagRids: taggable ? ctxRids : undefined, rows })}
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
          onShowDistinct={(col) => {
            setDistinctCol(col)
          }}
          onApplyInFilter={applyInFilter}
          onHide={hideColumn}
          onExtractJson={taggable ? (col) => setExtractCol(col) : undefined}
        />
      )}
      {popout && <CellPopout label={popout.label} value={popout.value} onClose={() => setPopout(null)} />}
      {rowPopout && <RowPopout title={rowPopout.title} fields={rowPopout.fields} onClose={() => setRowPopout(null)} />}
      {recordEvt && (
        <RecordEventDialog
          rowCount={recordEvt.rids.length}
          sourceName={doc.sourceName}
          wsId={wsId}
          onSubmit={(payload) => void recordEventFromRows(payload)}
          onClose={() => setRecordEvt(null)}
        />
      )}
      {extractCol && (
        <JsonExtractDialog
          tabId={doc.tabId}
          col={extractCol}
          onSubmit={extractJsonFields}
          onClose={() => setExtractCol(null)}
        />
      )}
      {cellMenu && (
        <CellContextMenu
          cell={cellMenu.cell}
          at={cellMenu.at}
          defaultMinutes={cellMenu.defaultMinutes}
          tagRids={cellMenu.tagRids}
          currentTag={cellMenu.tagRids?.length === 1 ? tags.get(cellMenu.tagRids[0]) : undefined}
          onFilter={applyValueFilter}
          onViewRow={
            cellMenu.rows?.length === 1
              ? () => setRowPopout({ title: 'Row', fields: rowFields(cellMenu.rows![0]) })
              : undefined
          }
          onRecordEvent={
            taggable && cellMenu.rows?.length && cellMenu.tagRids?.length
              ? () => setRecordEvt({ rids: cellMenu.tagRids!, rows: cellMenu.rows! })
              : undefined
          }
          onCopyRow={cellMenu.rows?.length ? () => copyRows(cellMenu.rows!) : undefined}
          copyRowCount={cellMenu.rows?.length}
          onPickTime={applyTimeAround}
          onPickBound={applyTimeBound}
          onTag={applyTag}
          onSend={
            onSendToEnrichment && classifyIndicator(cellMenu.cell.value)
              ? () => onSendToEnrichment([cellMenu.cell.value])
              : undefined
          }
          sendLabel={sendIntelLabel}
          onClearSighting={
            cellMenu.cell.rid != null && sightings.has(cellMenu.cell.rid)
              ? () => void clearRowSighting(cellMenu.cell.rid!)
              : undefined
          }
          onClose={() => setCellMenu(null)}
        />
      )}

      {sweepOpen && (
        <SweepDialog
          key={sweepKey}
          wsId={wsId}
          sources={sweepSources ?? [{ sourceId, name: doc.sourceName, columns: displayColumns, rowCount: doc.rowCount }]}
          initialSourceId={sourceId}
          initialText={sweepInitial}
          intelDbPath={intelDbPath}
          onClose={() => setSweepOpen(false)}
          onSwept={() => {
            setSightingRev((r) => r + 1)
            onSightingsChanged?.()
            onOpenSightings?.() // a finished sweep lands you on the results (Notepad++-style)
          }}
          onSeeSightings={() => {
            setSweepOpen(false)
            onOpenSightings?.()
          }}
        />
      )}

      {/* Export-to-CSV confirmation — shows how many events (the live filtered count) will be written. */}
      {exportOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
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
