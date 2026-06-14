import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Filter, ListTree, Loader2 } from 'lucide-react'
import type { CsvDoc } from '../../state/documents'
import type { CsvColumn, CsvDistinctRow, CsvFilter } from '../../state/csvTypes'

// Shortcut dropdown for a column's 3-dots button:
//  • "Distinct values" opens the distinct side panel.
//  • "Filter" expands a submenu of the column's distinct values with multi-select; applying
//    adds ONE `in` filter holding every checked value (re-opening pre-checks the current set).
// Anchored to the button via a fixed-position box so the grid's overflow can't clip it.

const DISTINCT_LIMIT = 1000
const MENU_W = 256

export function ColumnMenu({
  doc,
  col,
  filters,
  currentValues,
  anchor,
  initialShowFilter,
  onClose,
  onShowDistinct,
  onApplyInFilter
}: {
  doc: CsvDoc
  col: CsvColumn
  filters: CsvFilter[]
  /** Values already selected for this column's existing `in` filter (pre-checked). */
  currentValues: string[]
  anchor: { left: number; bottom: number }
  /** Open straight into the value multi-select (used when editing an `in` chip). */
  initialShowFilter?: boolean
  onClose: () => void
  onShowDistinct: (col: CsvColumn) => void
  onApplyInFilter: (col: string, values: string[]) => void
}): JSX.Element {
  const [showFilter, setShowFilter] = useState(!!initialShowFilter)
  const [rows, setRows] = useState<CsvDistinctRow[]>([])
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(false)
  const [needle, setNeedle] = useState('')
  const [selected, setSelected] = useState<Set<string>>(() => new Set(currentValues))
  const ref = useRef<HTMLDivElement>(null)
  const loadedRef = useRef(false)

  const left = Math.min(anchor.left, window.innerWidth - MENU_W - 8)

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

  // Load the distinct values once, the first time the Filter submenu is opened. `filters` is
  // read at fetch time (not a dep) so the parent re-rendering a fresh `filters` array — or
  // our own setLoading — can't re-run and self-cancel the in-flight request.
  useEffect(() => {
    if (!showFilter || loadedRef.current) return
    loadedRef.current = true
    let live = true
    setLoading(true)
    window.api.csv
      .distinct(doc.tabId, col.name, filters, DISTINCT_LIMIT)
      .then((res) => {
        if (!live) return
        setRows(res.rows)
        setTruncated(res.truncated || res.rows.length >= DISTINCT_LIMIT)
      })
      .finally(() => {
        if (live) setLoading(false)
      })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showFilter, doc.tabId, col.name])

  const shown = useMemo(() => {
    const n = needle.trim().toLowerCase()
    return n === '' ? rows : rows.filter((r) => r.val.toLowerCase().includes(n))
  }, [rows, needle])

  function toggle(val: string): void {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(val)) next.delete(val)
      else next.add(val)
      return next
    })
  }

  function apply(): void {
    onApplyInFilter(col.name, [...selected])
    onClose()
  }

  const item =
    'w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs text-citrus-dark hover:bg-citrus-pink-light/60 dark:text-citrus-night-text dark:hover:bg-citrus-night-elev'

  return (
    <div
      ref={ref}
      className="column-menu fixed z-50 flex flex-col rounded-lg border border-citrus-border bg-citrus-card shadow-lg overflow-hidden dark:border-citrus-night-border dark:bg-citrus-night-card"
      style={{ top: anchor.bottom + 4, left, width: MENU_W }}
    >
      <div className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wide text-citrus-muted border-b border-citrus-border/60 dark:text-citrus-night-muted dark:border-citrus-night-border/60 truncate">
        {col.original}
      </div>

      <button className={item} onClick={() => { onShowDistinct(col); onClose() }} title="Show distinct values in the side panel">
        <ListTree className="w-3.5 h-3.5 shrink-0 text-citrus-pink" />
        Distinct values
      </button>

      <div className="border-t border-citrus-border/60 dark:border-citrus-night-border/60" />
      <button className={item} onClick={() => setShowFilter((v) => !v)} title="Filter the grid to one or more values">
        <Filter className="w-3.5 h-3.5 shrink-0 text-citrus-pink" />
        Filter
        <span className="ml-auto text-citrus-muted dark:text-citrus-night-muted">{showFilter ? '▾' : '▸'}</span>
      </button>

      {showFilter && (
        <div className="flex flex-col border-t border-citrus-border/60 dark:border-citrus-night-border/60">
          <input
            autoFocus
            value={needle}
            onChange={(e) => setNeedle(e.target.value)}
            placeholder="find a value…"
            className="mx-2 my-1.5 px-2 py-1 text-[11px] rounded border border-citrus-border bg-citrus-cream text-citrus-dark outline-none focus:border-citrus-pink dark:border-citrus-night-border dark:bg-citrus-night dark:text-citrus-night-text"
          />
          <div className="max-h-48 overflow-auto scrollbar-none">
            {loading && (
              <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-citrus-muted dark:text-citrus-night-muted">
                <Loader2 className="w-3 h-3 animate-spin" /> loading…
              </div>
            )}
            {!loading && shown.length === 0 && (
              <div className="px-3 py-2 text-[11px] text-citrus-muted dark:text-citrus-night-muted">no values</div>
            )}
            {shown.map((r) => {
              const on = selected.has(r.val)
              return (
                <button
                  key={r.val}
                  className="w-full flex items-center gap-2 px-3 py-1 text-left text-[11px] font-mono hover:bg-citrus-pink-light/50 dark:hover:bg-citrus-night-elev"
                  onClick={() => toggle(r.val)}
                >
                  <span
                    className={`shrink-0 w-3.5 h-3.5 rounded-sm border flex items-center justify-center ${
                      on
                        ? 'bg-citrus-pink border-citrus-pink text-white'
                        : 'border-citrus-border dark:border-citrus-night-border'
                    }`}
                  >
                    {on && <Check className="w-2.5 h-2.5" />}
                  </span>
                  <span className="truncate flex-1 text-citrus-dark dark:text-citrus-night-text">{r.val === '' ? '∅ (empty)' : r.val}</span>
                  <span className="shrink-0 text-citrus-muted dark:text-citrus-night-muted">{r.cnt.toLocaleString()}</span>
                </button>
              )
            })}
            {truncated && (
              <div className="px-3 py-1.5 text-[10px] text-citrus-muted dark:text-citrus-night-muted">top {DISTINCT_LIMIT} shown</div>
            )}
          </div>
          <div className="flex items-center gap-1.5 px-2 py-1.5 border-t border-citrus-border/60 dark:border-citrus-night-border/60">
            <button
              className="flex-1 px-2 py-1 rounded-md text-[11px] font-bold bg-citrus-pink text-white hover:bg-citrus-pink-hover disabled:opacity-50"
              onClick={apply}
              title="Apply as one filter with the selected value(s)"
            >
              Apply{selected.size > 0 ? ` (${selected.size})` : ''}
            </button>
            {selected.size > 0 && (
              <button
                className="px-2 py-1 rounded-md text-[11px] font-bold text-citrus-muted hover:text-citrus-pink dark:text-citrus-night-muted"
                onClick={() => setSelected(new Set())}
                title="Clear selection"
              >
                Clear
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
