import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, MoreVertical } from 'lucide-react'
import type { CsvColumn, CsvSort } from '../../state/csvTypes'

const ROW_H = 28
const DEFAULT_COL_W = 168
const MIN_COL_W = 64
const IDX_W = 60

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
  baseOffset,
  total,
  sort,
  resetKey,
  onToggleSort,
  onOpenColumnMenu,
  onCellOpen,
  ensureRange
}: {
  columns: CsvColumn[]
  rows: string[][]
  baseOffset: number
  total: number
  sort?: CsvSort
  /** Changes when sort/filter/search change; scrolls the grid back to the top + clears selection. */
  resetKey?: string
  onToggleSort: (col: string) => void
  onOpenColumnMenu: (col: CsvColumn, anchor: { left: number; bottom: number }) => void
  onCellOpen: (value: string, label: string) => void
  ensureRange: (first: number, last: number) => void
}): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const rafRef = useRef(0)

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

  // --- cell selection ---
  const [sel, setSel] = useState<Selection | null>(null)
  const drag = useRef<{ active: boolean; rowMode: boolean }>({ active: false, rowMode: false })
  const lastCol = columns.length - 1

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
        for (let c = minC; c <= maxC; c++) cells.push(row ? row[c] ?? '' : '')
        lines.push(cells.join('\t'))
      }
      void navigator.clipboard.writeText(lines.join('\n')).catch(() => {})
    },
    [sel, rows, baseOffset]
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
      className="csv-grid relative flex-1 min-h-0 overflow-auto select-none outline-none"
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
              className="group relative shrink-0 flex items-center gap-1 px-2 text-[11px] font-bold uppercase tracking-wide border-l border-citrus-border/60 dark:border-citrus-night-border/60"
              style={{ width: widths[idx] ?? DEFAULT_COL_W }}
            >
              <button
                className="flex-1 flex items-center gap-1 truncate text-left hover:text-citrus-pink"
                onClick={() => onToggleSort(col.name)}
                title={`Sort by ${col.original}`}
              >
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
              {/* drag-to-resize handle on the right edge */}
              <div
                onMouseDown={(e) => startResize(e, idx)}
                className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-citrus-pink/40"
                title="Drag to resize column"
              />
            </div>
          )
        })}
      </div>

      {/* body: full-height spacer, windowed rows positioned absolutely */}
      <div style={{ height: Math.max(total, 1) * ROW_H, width: totalWidth, position: 'relative' }}>
        {rows.map((row, i) => {
          const abs = baseOffset + i
          return (
            <div
              key={abs}
              className="flex items-stretch text-xs font-mono border-b border-citrus-border/30 dark:border-citrus-night-border/30"
              style={{ position: 'absolute', top: abs * ROW_H, height: ROW_H, width: totalWidth }}
            >
              <div
                className="shrink-0 flex items-center justify-end pr-2 text-[10px] text-citrus-muted/70 select-none cursor-pointer hover:text-citrus-pink dark:text-citrus-night-muted/70"
                style={{ width: IDX_W }}
                onMouseDown={(e) => beginRow(e, abs)}
                onMouseEnter={() => enterRow(abs)}
                title="Select row"
              >
                {abs + 1}
              </div>
              {columns.map((col, c) => (
                <div
                  key={col.name}
                  className={`shrink-0 flex items-center px-2 truncate border-l ${
                    inSel(abs, c)
                      ? 'bg-citrus-pink/20 border-citrus-pink/30 dark:bg-citrus-pink/25'
                      : 'text-citrus-dark border-citrus-border/20 dark:text-citrus-night-text dark:border-citrus-night-border/20'
                  }`}
                  style={{ width: widths[c] ?? DEFAULT_COL_W }}
                  title={row[c]}
                  onMouseDown={(e) => beginCell(e, abs, c)}
                  onMouseEnter={() => enterCell(abs, c)}
                  onDoubleClick={() => onCellOpen(row[c] ?? '', `Row ${abs + 1} · ${col.original}`)}
                >
                  <span className="truncate">{row[c]}</span>
                </div>
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}
