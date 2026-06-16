import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowDown, ArrowUp, Clock, Crosshair, MapPin, MoreVertical } from 'lucide-react'
import type { CsvColumn, CsvSort, TimeKind } from '../../state/csvTypes'
import { classifyCellTime } from '../../state/timeKind'
import { tagDef } from '../../state/tags'

export interface CellRef {
  colName: string
  original: string
  value: string
  /** Detected time kind, when the cell is a time column (or its value parses as a time). */
  tkind?: TimeKind
  /** Positional rowid of the cell's row — the pivot anchor we scroll back to after a ± filter. */
  rid?: number
}

/** Imperative handle for driving the grid from a parent (e.g. search "jump to next match"). */
export interface VirtualGridHandle {
  /** Scroll an absolute row index into view (centered) and select the whole row. */
  scrollToRow: (index: number) => void
}

const ROW_H = 28
const DEFAULT_COL_W = 168

const MARK_SEARCH = 'bg-citrus-pink/40 text-inherit rounded-sm dark:bg-citrus-pink/50'
const MARK_SIGHTING = 'bg-red-400/40 text-inherit rounded-sm dark:bg-red-500/50'

/** Wrap every (case-insensitive) occurrence of any term in a colored <mark>. Overlapping matches
 *  resolve first-come (sightings are listed before search), so a cell can show both colors without
 *  nesting. Returns the plain string when nothing matches. */
function highlightTerms(text: string, terms: Array<{ needle: string; cls: string }>): React.ReactNode {
  if (!text || terms.length === 0) return text
  const lower = text.toLowerCase()
  const ranges: Array<{ start: number; end: number; cls: string }> = []
  for (const { needle, cls } of terms) {
    if (!needle) continue
    const n = needle.toLowerCase()
    let i = lower.indexOf(n)
    while (i !== -1) {
      ranges.push({ start: i, end: i + n.length, cls })
      i = lower.indexOf(n, i + n.length)
    }
  }
  if (ranges.length === 0) return text
  ranges.sort((a, b) => a.start - b.start || b.end - a.end)
  const out: React.ReactNode[] = []
  let pos = 0
  let key = 0
  for (const r of ranges) {
    if (r.start < pos) continue // overlaps an already-emitted mark → skip
    if (r.start > pos) out.push(text.slice(pos, r.start))
    out.push(
      <mark key={key++} className={r.cls}>
        {text.slice(r.start, r.end)}
      </mark>
    )
    pos = r.end
  }
  if (pos < text.length) out.push(text.slice(pos))
  return out
}
const MIN_COL_W = 64
const MAX_AUTOFIT_W = 800
const IDX_W = 60

/** Measure the pixel width a column needs to show `longest` (and its header) without truncating. */
function measureColWidth(header: string, longest: string, host: HTMLElement | null): number {
  const root = host ?? document.body
  const measure = (cls: string, text: string): number => {
    const el = document.createElement('span')
    el.className = cls
    el.style.position = 'absolute'
    el.style.visibility = 'hidden'
    el.style.whiteSpace = 'pre'
    el.style.pointerEvents = 'none'
    el.textContent = text
    root.appendChild(el)
    const w = el.offsetWidth
    root.removeChild(el)
    return w
  }
  const contentW = measure('text-xs font-mono', longest) + 20 // px-2 padding + small buffer
  const headerW = measure('text-[11px] font-bold uppercase tracking-wide', header) + 52 // padding + sort/dots icons
  return Math.min(MAX_AUTOFIT_W, Math.max(MIN_COL_W, Math.ceil(Math.max(contentW, headerW))))
}

// Manually windowed table: a single scroll container with a sticky header and a tall spacer
// sized to the full row count; only the rows in the hook's current window are in the DOM,
// absolutely positioned at their true offset. Columns are drag-resizable; cells support an
// Excel-style rectangular selection (click an anchor, drag or shift-click to extend) that
// Ctrl+C copies as TSV. Double-click opens a cell's full value. Native text drag-select is
// disabled so highlighting a cell doesn't smear across the whole row.

interface Cell {
  r: number // absolute row index
  c: number // column index
}
interface Selection {
  anchor: Cell
  focus: Cell
}

function rect(sel: Selection): { minR: number; maxR: number; minC: number; maxC: number } {
  return {
    minR: Math.min(sel.anchor.r, sel.focus.r),
    maxR: Math.max(sel.anchor.r, sel.focus.r),
    minC: Math.min(sel.anchor.c, sel.focus.c),
    maxC: Math.max(sel.anchor.c, sel.focus.c)
  }
}

export function VirtualGrid({
  columns,
  rows,
  rids,
  tags,
  sightings,
  anchorRid,
  baseOffset,
  total,
  sort,
  search,
  resetKey,
  onToggleSort,
  onOpenColumnMenu,
  onCellOpen,
  getLongest,
  onCellContext,
  ensureRange,
  controllerRef,
  onReorderColumns
}: {
  columns: CsvColumn[]
  rows: string[][]
  /** Positional rowid of each loaded row (aligned with `rows`) — identity for tags + scroll. */
  rids: number[]
  /** Map of rowid → tag id; drives the colored left marker. Undefined when the source is untagged. */
  tags?: Map<number, string>
  /** Map of rowid → the indicators that matched on that row; drives the gutter marker + cell highlight. */
  sightings?: Map<number, string[]>
  /** The pivot anchor's rowid — that row gets a persistent pink ring + pin so you don't lose your spot. */
  anchorRid?: number
  baseOffset: number
  total: number
  sort?: CsvSort
  /** Active (debounced) search term — matches are highlighted in visible cells. */
  search?: string
  /** Changes when sort/filter/search change; scrolls the grid back to the top + clears selection. */
  resetKey?: string
  onToggleSort: (col: string) => void
  onOpenColumnMenu: (col: CsvColumn, anchor: { left: number; bottom: number }) => void
  onCellOpen: (value: string, label: string) => void
  /** Fetch a column's longest value (whole table) for double-click auto-fit. */
  getLongest: (colName: string) => Promise<string>
  /**
   * Right-clicking any cell opens the cell menu (filter/exclude, + time pivots if applicable).
   * `rids` are the rows a Tag-as action should hit: the clicked row, or — when the click lands
   * inside a multi-row selection — every loaded row in that selection.
   */
  onCellContext: (cell: CellRef, at: { x: number; y: number }, rids: number[]) => void
  ensureRange: (first: number, last: number) => void
  /** Parent ref for imperative control (scroll-to-match). */
  controllerRef?: React.Ref<VirtualGridHandle>
  /** Drag a header to reorder columns (from → to are positions in `columns`). */
  onReorderColumns?: (from: number, to: number) => void
}): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)

  // Row windowing via TanStack Virtual: only the rows in the current visual window are in the DOM.
  // `count` is the full (possibly multi-million) row total; the data for any given index lives in
  // the `rows` prop at `index - baseOffset` (the SQL-backed window the parent pages in). The sticky
  // header occupies ROW_H of in-flow space above the list, so `scrollMargin: ROW_H` keeps the
  // virtualizer's offsets aligned with it (and makes scrollToIndex land in the right place).
  const virtualizer = useVirtualizer({
    count: total,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 12,
    scrollMargin: ROW_H
  })
  const virtualItems = virtualizer.getVirtualItems()

  // Row data always arrives in the ORIGINAL column order (the query selects c0..cN), while
  // `columns` may be reordered for display. Map each display position → its data index (the
  // numeric suffix of the stable `c<n>` name) so a reordered header still reads the right cell.
  const dataIdx = useMemo(() => columns.map((c) => Number(c.name.slice(1))), [columns])

  // --- column widths (drag-resizable) ---
  const [widths, setWidths] = useState<number[]>(() => columns.map(() => DEFAULT_COL_W))
  useEffect(() => {
    setWidths((w) => (w.length === columns.length ? w : columns.map((_, i) => w[i] ?? DEFAULT_COL_W)))
  }, [columns])
  const totalWidth = IDX_W + widths.reduce((a, b) => a + b, 0)

  const resize = useRef<{ idx: number; startX: number; startW: number } | null>(null)
  const startResize = useCallback((e: React.MouseEvent, idx: number) => {
    e.preventDefault()
    e.stopPropagation()
    resize.current = { idx, startX: e.clientX, startW: widths[idx] ?? DEFAULT_COL_W }
    const onMove = (ev: MouseEvent): void => {
      const r = resize.current
      if (!r) return
      const next = Math.max(MIN_COL_W, r.startW + (ev.clientX - r.startX))
      setWidths((w) => w.map((x, i) => (i === r.idx ? next : x)))
    }
    const onUp = (): void => {
      resize.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [widths])

  // Double-click the handle → auto-fit the column to its widest value across the WHOLE table.
  const autoFit = useCallback(
    async (idx: number, col: CsvColumn) => {
      let longest = ''
      try {
        longest = await getLongest(col.name)
      } catch {
        /* fall back to header-only width */
      }
      const w = measureColWidth(col.original, longest, scrollRef.current)
      setWidths((ws) => ws.map((x, i) => (i === idx ? w : x)))
    },
    [getLongest]
  )

  // --- cell selection ---
  const [sel, setSel] = useState<Selection | null>(null)
  const drag = useRef<{ active: boolean; rowMode: boolean }>({ active: false, rowMode: false })
  const lastCol = columns.length - 1

  // --- column drag-to-reorder ---
  const [dragCol, setDragCol] = useState<number | null>(null)
  const [overCol, setOverCol] = useState<number | null>(null)
  const onColDragStart = useCallback((e: React.DragEvent, idx: number) => {
    if (resize.current) {
      e.preventDefault() // a resize is in progress — don't start a reorder drag
      return
    }
    setDragCol(idx)
    e.dataTransfer.effectAllowed = 'move'
    try {
      e.dataTransfer.setData('text/plain', String(idx)) // Firefox needs data set to drag
    } catch {
      /* noop */
    }
  }, [])
  const onColDragOver = useCallback(
    (e: React.DragEvent, idx: number) => {
      if (dragCol == null) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      if (idx !== overCol) setOverCol(idx)
    },
    [dragCol, overCol]
  )
  const onColDrop = useCallback(
    (e: React.DragEvent, idx: number) => {
      e.preventDefault()
      const from = dragCol
      setDragCol(null)
      setOverCol(null)
      if (from == null || from === idx) return
      // Permute local widths with the SAME splice semantics the parent uses on `columns`.
      setWidths((ws) => {
        const a = [...ws]
        const [m] = a.splice(from, 1)
        a.splice(idx, 0, m)
        return a
      })
      setSel(null) // existing selection indices refer to the old column order
      onReorderColumns?.(from, idx)
    },
    [dragCol, onReorderColumns]
  )
  const onColDragEnd = useCallback(() => {
    setDragCol(null)
    setOverCol(null)
  }, [])

  // Imperative scroll-to-match: center the row, select it, and let the virtualizer load its window.
  useImperativeHandle(
    controllerRef,
    () => ({
      scrollToRow(index: number) {
        if (index < 0 || index >= total) return
        virtualizer.scrollToIndex(index, { align: 'center' })
        setSel({ anchor: { r: index, c: 0 }, focus: { r: index, c: lastCol } })
      }
    }),
    [total, lastCol, virtualizer]
  )

  useEffect(() => {
    const onUp = (): void => {
      drag.current.active = false
    }
    window.addEventListener('mouseup', onUp)
    return () => window.removeEventListener('mouseup', onUp)
  }, [])

  const beginCell = useCallback(
    (e: React.MouseEvent, r: number, c: number) => {
      if (e.button !== 0) return
      e.preventDefault() // suppress native text selection
      scrollRef.current?.focus()
      drag.current = { active: true, rowMode: false }
      setSel((prev) => (e.shiftKey && prev ? { anchor: prev.anchor, focus: { r, c } } : { anchor: { r, c }, focus: { r, c } }))
    },
    []
  )
  const enterCell = useCallback((r: number, c: number) => {
    if (!drag.current.active || drag.current.rowMode) return
    setSel((prev) => (prev ? { anchor: prev.anchor, focus: { r, c } } : prev))
  }, [])

  const beginRow = useCallback(
    (e: React.MouseEvent, r: number) => {
      if (e.button !== 0) return
      e.preventDefault()
      scrollRef.current?.focus()
      drag.current = { active: true, rowMode: true }
      setSel((prev) =>
        e.shiftKey && prev
          ? { anchor: { r: prev.anchor.r, c: 0 }, focus: { r, c: lastCol } }
          : { anchor: { r, c: 0 }, focus: { r, c: lastCol } }
      )
    },
    [lastCol]
  )
  const enterRow = useCallback(
    (r: number) => {
      if (!drag.current.active || !drag.current.rowMode) return
      setSel((prev) => (prev ? { anchor: { r: prev.anchor.r, c: 0 }, focus: { r, c: lastCol } } : prev))
    },
    [lastCol]
  )

  // Ctrl/Cmd+C → copy the selected rectangle as TSV (rows that are loaded in the window).
  const onCopy = useCallback(
    (e: React.KeyboardEvent) => {
      if (!((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) || !sel) return
      e.preventDefault()
      const { minR, maxR, minC, maxC } = rect(sel)
      const lines: string[] = []
      for (let r = minR; r <= maxR; r++) {
        const row = rows[r - baseOffset]
        const cells: string[] = []
        for (let c = minC; c <= maxC; c++) cells.push(row ? row[dataIdx[c]] ?? '' : '')
        lines.push(cells.join('\t'))
      }
      void navigator.clipboard.writeText(lines.join('\n')).catch(() => {})
    },
    [sel, rows, baseOffset, dataIdx]
  )

  // Keep row `r` just inside the viewport (no centering) — used while arrow-navigating selection.
  const scrollRowIntoView = useCallback(
    (r: number) => {
      virtualizer.scrollToIndex(r, { align: 'auto' })
    },
    [virtualizer]
  )

  // Clicking a row's sighting crosshair jumps to the cell holding the match: find the first column
  // whose value contains a matched indicator, scroll it into view (both axes), and select that cell.
  const jumpToSightingCell = useCallback(
    (absRow: number, rowData: string[], vals: string[]) => {
      const lc = vals.map((v) => v.toLowerCase())
      let c = columns.findIndex((_, i) => {
        const cell = (rowData[dataIdx[i]] ?? '').toLowerCase()
        return lc.some((v) => v !== '' && cell.includes(v))
      })
      if (c < 0) c = 0
      virtualizer.scrollToIndex(absRow, { align: 'center' })
      const left = IDX_W + widths.slice(0, c).reduce((a, b) => a + (b ?? DEFAULT_COL_W), 0)
      if (scrollRef.current) scrollRef.current.scrollLeft = Math.max(0, left - 48)
      scrollRef.current?.focus()
      setSel({ anchor: { r: absRow, c }, focus: { r: absRow, c } })
    },
    [columns, dataIdx, widths, virtualizer]
  )

  // ArrowUp/Down move the selected row; Shift+ArrowUp/Down extend it (full-width rows). Other keys
  // (Ctrl/Cmd+C) fall through to the copy handler.
  const onGridKey = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') {
        onCopy(e)
        return
      }
      if (total === 0) return
      e.preventDefault()
      const cur = sel ? sel.focus.r : -1
      const nextR = cur < 0 ? 0 : Math.min(total - 1, Math.max(0, cur + (e.key === 'ArrowDown' ? 1 : -1)))
      setSel((prev) =>
        e.shiftKey && prev
          ? { anchor: { r: prev.anchor.r, c: 0 }, focus: { r: nextR, c: lastCol } }
          : { anchor: { r: nextR, c: 0 }, focus: { r: nextR, c: lastCol } }
      )
      scrollRowIntoView(nextR)
    },
    [onCopy, total, sel, lastCol, scrollRowIntoView]
  )

  // Page in the SQL window for whatever rows the virtualizer currently has mounted (it already
  // includes overscan; the parent's ensureRange widens with its own overscan on top). Keyed on the
  // window edges + `total` so it also fires for the initial window and after a resize/result change.
  const firstVisible = virtualItems.length ? virtualItems[0].index : 0
  const lastVisible = virtualItems.length ? virtualItems[virtualItems.length - 1].index : 0
  useEffect(() => {
    if (total > 0) ensureRange(firstVisible, Math.min(total - 1, lastVisible))
  }, [ensureRange, total, firstVisible, lastVisible])

  // Result set changed (sort/filter/search): jump to top and clear the stale selection.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0
    setSel(null)
  }, [resetKey])

  // Right-click any cell → open the cell menu (filter to / exclude value, plus ± time pivots
  // when the column is a time column or the value itself parses as a time).
  const onContextMenu = useCallback(
    (e: React.MouseEvent, r: number, c: number) => {
      const col = columns[c]
      const value = rows[r - baseOffset]?.[dataIdx[c]]
      if (col == null || value == null) return
      e.preventDefault()
      // If the right-click lands inside a multi-row selection, the Tag-as action targets every
      // loaded row in that selection; otherwise just this row (and we re-anchor onto it).
      const sr = sel ? rect(sel) : null
      let ctxRids: number[]
      if (sr && sr.maxR > sr.minR && r >= sr.minR && r <= sr.maxR) {
        ctxRids = []
        for (let rr = sr.minR; rr <= sr.maxR; rr++) {
          const rid = rids[rr - baseOffset]
          if (rid != null) ctxRids.push(rid)
        }
      } else {
        setSel({ anchor: { r, c }, focus: { r, c } }) // highlight what we're acting on
        const rid = rids[r - baseOffset]
        ctxRids = rid != null ? [rid] : []
      }
      const tkind = col.time ?? classifyCellTime(value) ?? undefined
      const rid = rids[r - baseOffset]
      onCellContext({ colName: col.name, original: col.original, value, tkind, rid }, { x: e.clientX, y: e.clientY }, ctxRids)
    },
    [columns, rows, rids, baseOffset, dataIdx, sel, onCellContext]
  )

  const r0 = sel ? rect(sel) : null
  const inSel = (r: number, c: number): boolean =>
    !!r0 && r >= r0.minR && r <= r0.maxR && c >= r0.minC && c <= r0.maxC

  return (
    <div
      ref={scrollRef}
      onKeyDown={onGridKey}
      tabIndex={0}
      className="csv-grid relative flex-1 min-w-0 min-h-0 overflow-auto select-none outline-none"
    >
      {/* sticky header */}
      <div
        className="sticky top-0 z-10 flex bg-citrus-sand text-citrus-dark border-b border-citrus-border dark:bg-citrus-night-elev dark:text-citrus-night-text dark:border-citrus-night-border"
        style={{ width: totalWidth, height: ROW_H }}
      >
        <div
          className="shrink-0 flex items-center justify-end pr-2 text-[10px] font-mono text-citrus-muted dark:text-citrus-night-muted"
          style={{ width: IDX_W }}
        >
          #
        </div>
        {columns.map((col, idx) => {
          const active = sort?.col === col.name
          return (
            <div
              key={col.name}
              draggable={!!onReorderColumns}
              onDragStart={(e) => onColDragStart(e, idx)}
              onDragOver={(e) => onColDragOver(e, idx)}
              onDrop={(e) => onColDrop(e, idx)}
              onDragEnd={onColDragEnd}
              className={`group relative shrink-0 flex items-center gap-1 px-2 text-[11px] font-bold uppercase tracking-wide border-l border-citrus-border/60 dark:border-citrus-night-border/60 ${
                dragCol === idx ? 'opacity-40' : ''
              } ${overCol === idx && dragCol !== idx ? 'border-l-2 border-l-citrus-pink bg-citrus-pink/10' : ''}`}
              style={{ width: widths[idx] ?? DEFAULT_COL_W }}
            >
              <button
                className="flex-1 flex items-center gap-1 truncate text-left hover:text-citrus-pink"
                onClick={() => onToggleSort(col.name)}
                title={`Sort by ${col.original}`}
              >
                {col.time && (
                  <span className="shrink-0 flex" title={`Time column (${col.time})`}>
                    <Clock className="w-3 h-3 text-citrus-pink/70" />
                  </span>
                )}
                <span className="truncate">{col.original}</span>
                {active &&
                  (sort?.dir === 'asc' ? (
                    <ArrowUp className="w-3 h-3 shrink-0" />
                  ) : (
                    <ArrowDown className="w-3 h-3 shrink-0" />
                  ))}
              </button>
              <button
                className="shrink-0 text-citrus-muted opacity-50 group-hover:opacity-100 hover:text-citrus-pink dark:text-citrus-night-muted"
                onClick={(e) => {
                  const rb = e.currentTarget.getBoundingClientRect()
                  onOpenColumnMenu(col, { left: rb.left, bottom: rb.bottom })
                }}
                title="Column values / pivot / filter"
              >
                <MoreVertical className="w-3.5 h-3.5" />
              </button>
              {/* drag-to-resize handle on the right edge; double-click auto-fits to content */}
              <div
                onMouseDown={(e) => startResize(e, idx)}
                onDoubleClick={(e) => {
                  e.stopPropagation()
                  void autoFit(idx, col)
                }}
                className="col-resize absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-citrus-pink/40"
                title="Drag to resize · double-click to fit"
              />
            </div>
          )
        })}
      </div>

      {/* body: virtualizer-sized spacer; only the rows in the current visual window are mounted,
          each translated to its true offset. A row whose SQL data hasn't paged into the loaded
          window yet renders as a blank skeleton (just the index gutter) until ensureRange fills it. */}
      <div style={{ height: Math.max(virtualizer.getTotalSize(), 1), width: totalWidth, position: 'relative' }}>
        {virtualItems.map((vi) => {
          const abs = vi.index
          const wi = abs - baseOffset
          const row = wi >= 0 && wi < rows.length ? rows[wi] : undefined
          const rid = row ? rids[wi] : undefined
          const tag = tags && rid != null ? tagDef(tags.get(rid)) : undefined
          const sightingVals = sightings && rid != null ? sightings.get(rid) : undefined
          const isAnchor = anchorRid != null && rid != null && rid === anchorRid
          // Highlight terms for this row's cells: matched indicators (red) + the search term (pink).
          const cellTerms: Array<{ needle: string; cls: string }> = []
          if (sightingVals) for (const sv of sightingVals) cellTerms.push({ needle: sv, cls: MARK_SIGHTING })
          if (search) cellTerms.push({ needle: search, cls: MARK_SEARCH })
          const top = vi.start - virtualizer.options.scrollMargin
          if (!row) {
            // Skeleton row: data for this index isn't in the loaded window yet.
            return (
              <div
                key={abs}
                className="flex items-stretch text-xs font-mono border-b border-citrus-border/30 dark:border-citrus-night-border/30"
                style={{ position: 'absolute', top, height: ROW_H, width: totalWidth }}
              >
                <div
                  className="shrink-0 flex items-center justify-end pr-2 text-[10px] text-citrus-muted/40 select-none dark:text-citrus-night-muted/40"
                  style={{ width: IDX_W }}
                >
                  {abs + 1}
                </div>
              </div>
            )
          }
          return (
            <div
              key={abs}
              className={`flex items-stretch text-xs font-mono border-b border-citrus-border/30 dark:border-citrus-night-border/30 ${tag?.row ?? ''} ${
                isAnchor ? 'ring-2 ring-inset ring-citrus-pink bg-citrus-pink/10 z-[1] dark:bg-citrus-pink/15' : ''
              }`}
              style={{ position: 'absolute', top, height: ROW_H, width: totalWidth }}
            >
              {tag && (
                <div
                  className={`absolute left-0 top-0 h-full w-[3px] ${tag.bar}`}
                  title={tag.label}
                />
              )}
              <div
                className={`shrink-0 flex items-center justify-end gap-0.5 pr-2 text-[10px] select-none cursor-pointer hover:text-citrus-pink ${
                  isAnchor ? 'font-bold text-citrus-pink' : 'text-citrus-muted/70 dark:text-citrus-night-muted/70'
                }`}
                style={{ width: IDX_W }}
                onMouseDown={(e) => beginRow(e, abs)}
                onMouseEnter={() => enterRow(abs)}
                title={isAnchor ? 'Pivot anchor — the row you pivoted from' : 'Select row'}
              >
                {sightingVals != null && (
                  <button
                    className="shrink-0 flex text-red-500 hover:text-red-600 dark:text-red-400"
                    title={`Sighting — ${sightingVals.join(', ')} · click to jump to the match`}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation()
                      jumpToSightingCell(abs, row, sightingVals)
                    }}
                  >
                    <Crosshair className="w-3 h-3" />
                  </button>
                )}
                {isAnchor && <MapPin className="w-3 h-3 shrink-0" />}
                {abs + 1}
              </div>
              {columns.map((col, c) => {
                const v = row[dataIdx[c]] ?? ''
                return (
                  <div
                    key={col.name}
                    className={`shrink-0 flex items-center px-2 truncate border-l ${
                      inSel(abs, c)
                        ? 'bg-citrus-pink/20 border-citrus-pink/30 dark:bg-citrus-pink/25'
                        : 'text-citrus-dark border-citrus-border/20 dark:text-citrus-night-text dark:border-citrus-night-border/20'
                    }`}
                    style={{ width: widths[c] ?? DEFAULT_COL_W }}
                    title={v}
                    onMouseDown={(e) => beginCell(e, abs, c)}
                    onMouseEnter={() => enterCell(abs, c)}
                    onContextMenu={(e) => onContextMenu(e, abs, c)}
                    onDoubleClick={() => onCellOpen(v, `Row ${abs + 1} · ${col.original}`)}
                  >
                    <span className="truncate">{cellTerms.length ? highlightTerms(v, cellTerms) : v}</span>
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
    </div>
  )
}
