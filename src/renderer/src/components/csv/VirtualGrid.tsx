import { useCallback, useEffect, useRef } from 'react'
import { ArrowDown, ArrowUp, MoreVertical } from 'lucide-react'
import type { CsvColumn, CsvSort } from '../../state/csvTypes'

const ROW_H = 28
const COL_W = 168
const IDX_W = 60

// Manually windowed table: a single scroll container with a sticky header and a tall spacer
// sized to the full row count; only the rows in view (the hook's current window) are in the
// DOM, absolutely positioned at their true offset. Pages are fetched via ensureRange.

export function VirtualGrid({
  columns,
  rows,
  baseOffset,
  total,
  sort,
  onToggleSort,
  onPickColumn,
  ensureRange
}: {
  columns: CsvColumn[]
  rows: string[][]
  baseOffset: number
  total: number
  sort?: CsvSort
  onToggleSort: (col: string) => void
  onPickColumn: (col: CsvColumn) => void
  ensureRange: (first: number, last: number) => void
}): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const rafRef = useRef(0)
  const totalWidth = IDX_W + columns.length * COL_W

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

  // Ensure the initial viewport is loaded once the row count is known / on resize.
  useEffect(() => {
    recompute()
  }, [recompute, total])

  return (
    <div ref={scrollRef} onScroll={onScroll} className="csv-grid relative flex-1 min-h-0 overflow-auto">
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
        {columns.map((col) => {
          const active = sort?.col === col.name
          return (
            <div
              key={col.name}
              className="group shrink-0 flex items-center gap-1 px-2 text-[11px] font-bold uppercase tracking-wide border-l border-citrus-border/60 dark:border-citrus-night-border/60"
              style={{ width: COL_W }}
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
                onClick={() => onPickColumn(col)}
                title="Column values / pivot"
              >
                <MoreVertical className="w-3.5 h-3.5" />
              </button>
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
              className="flex items-stretch text-xs font-mono border-b border-citrus-border/30 hover:bg-citrus-pink-light/40 dark:border-citrus-night-border/30 dark:hover:bg-citrus-night-elev/60"
              style={{ position: 'absolute', top: abs * ROW_H, height: ROW_H, width: totalWidth }}
            >
              <div
                className="shrink-0 flex items-center justify-end pr-2 text-[10px] text-citrus-muted/70 select-none dark:text-citrus-night-muted/70"
                style={{ width: IDX_W }}
              >
                {abs + 1}
              </div>
              {columns.map((col, c) => (
                <div
                  key={col.name}
                  className="shrink-0 flex items-center px-2 truncate text-citrus-dark border-l border-citrus-border/20 dark:text-citrus-night-text dark:border-citrus-night-border/20"
                  style={{ width: COL_W }}
                  title={row[c]}
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
