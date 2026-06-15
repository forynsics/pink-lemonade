import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Clock, MapPin, MoreVertical } from 'lucide-react'
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

/** Split a cell value on the (case-insensitive) search term, wrapping matches in <mark>. */
function highlight(text: string, term: string): React.ReactNode {
  if (!term || !text) return text
  const lower = text.toLowerCase()
  const needle = term.toLowerCase()
  const out: React.ReactNode[] = []
  let from = 0
  let hit = lower.indexOf(needle, from)
  if (hit === -1) return text
  let key = 0
  while (hit !== -1) {
    if (hit > from) out.push(text.slice(from, hit))
    out.push(
      <mark key={key++} className="bg-citrus-pink/40 text-inherit rounded-sm dark:bg-citrus-pink/50">
        {text.slice(hit, hit + needle.length)}
      </mark>
    )
    from = hit + needle.length
    hit = lower.indexOf(needle, from)
  }
  if (from < text.length) out.push(text.slice(from))
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
  const rafRef = useRef(0)

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

  // Imperative scroll-to-match: center the row, select it, and let onScroll load its window.
  useImperativeHandle(
    controllerRef,
    () => ({
      scrollToRow(index: number) {
        const el = scrollRef.current
        if (!el || index < 0 || index >= total) return
        const target = index * ROW_H - el.clientHeight / 2 + ROW_H / 2
        el.scrollTop = Math.max(0, target)
        setSel({ anchor: { r: index, c: 0 }, focus: { r: index, c: lastCol } })
      }
    }),
    [total, lastCol]
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

  const recompute = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const first = Math.floor(el.scrollTop / ROW_H)
    const visible = Math.ceil(el.clientHeight / ROW_H)
    ensureRange(first, Math.min(total - 1, first + visible))
  }, [ensureRange, total])

  const onScroll = useCallback(() => {
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      recompute()
    })
  }, [recompute])

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

  // Ensure the initial viewport is loaded once the row count is known / on resize.
  useEffect(() => {
    recompute()
  }, [recompute, total])

  const r0 = sel ? rect(sel) : null
  const inSel = (r: number, c: number): boolean =>
    !!r0 && r >= r0.minR && r <= r0.maxR && c >= r0.minC && c <= r0.maxC

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      onKeyDown={onCopy}
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

      {/* body: full-height spacer, windowed rows positioned absolutely */}
      <div style={{ height: Math.max(total, 1) * ROW_H, width: totalWidth, position: 'relative' }}>
        {rows.map((row, i) => {
          const abs = baseOffset + i
          const tag = tags && rids[i] != null ? tagDef(tags.get(rids[i])) : undefined
          const isAnchor = anchorRid != null && rids[i] === anchorRid
          return (
            <div
              key={abs}
              className={`flex items-stretch text-xs font-mono border-b border-citrus-border/30 dark:border-citrus-night-border/30 ${tag?.row ?? ''} ${
                isAnchor ? 'ring-2 ring-inset ring-citrus-pink bg-citrus-pink/10 z-[1] dark:bg-citrus-pink/15' : ''
              }`}
              style={{ position: 'absolute', top: abs * ROW_H, height: ROW_H, width: totalWidth }}
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
                    <span className="truncate">{search ? highlight(v, search) : v}</span>
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
