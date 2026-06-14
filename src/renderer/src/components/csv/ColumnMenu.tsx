import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRightLeft, Filter, ListTree, Loader2 } from 'lucide-react'
import type { CsvDoc } from '../../state/documents'
import type { CsvColumn, CsvDistinctRow, CsvFilter } from '../../state/csvTypes'

// Compact dropdown for a column's 3-dots button: pivot distinct/all values into a scratch
// tab, or filter the grid to one value (the distinct list loads lazily under "Filter to
// value"). Anchored to the button via a fixed-position box so the grid's overflow can't clip
// it. Replaces the old side panel.

const DISTINCT_LIMIT = 1000
const MENU_W = 264

export function ColumnMenu({
  doc,
  col,
  filters,
  anchor,
  onClose,
  onPivot,
  onAddFilter
}: {
  doc: CsvDoc
  col: CsvColumn
  filters: CsvFilter[]
  anchor: { left: number; bottom: number }
  onClose: () => void
  onPivot: (values: string[], label: string) => void
  onAddFilter: (f: CsvFilter) => void
}): JSX.Element {
  const [showValues, setShowValues] = useState(false)
  const [rows, setRows] = useState<CsvDistinctRow[]>([])
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(false)
  const [busyAll, setBusyAll] = useState(false)
  const [needle, setNeedle] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  const label = `${doc.sourceName} · ${col.original}`
  const left = Math.min(anchor.left, window.innerWidth - MENU_W - 8)

  // Close on outside click / Esc.
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

  // Lazily load distinct values the first time "Filter to value" is expanded.
  useEffect(() => {
    if (!showValues || rows.length > 0 || loading) return
    let live = true
    setLoading(true)
    window.api.csv
      .distinct(doc.tabId, col.name, filters, DISTINCT_LIMIT)
      .then((res) => {
        if (!live) return
        setRows(res.rows)
        setTruncated(res.truncated || res.rows.length >= DISTINCT_LIMIT)
      })
      .finally(() => live && setLoading(false))
    return () => {
      live = false
    }
  }, [showValues, doc.tabId, col.name, filters, rows.length, loading])

  const shown = useMemo(() => {
    const n = needle.trim().toLowerCase()
    return n === '' ? rows : rows.filter((r) => r.val.toLowerCase().includes(n))
  }, [rows, needle])

  function pivotDistinct(): void {
    setLoading(true)
    window.api.csv
      .distinct(doc.tabId, col.name, filters, DISTINCT_LIMIT)
      .then((res) => {
        onPivot(res.rows.map((r) => r.val), label)
        onClose()
      })
      .finally(() => setLoading(false))
  }

  async function pivotAll(): Promise<void> {
    setBusyAll(true)
    try {
      const res = await window.api.csv.values(doc.tabId, col.name, filters)
      onPivot(res.values, label)
      onClose()
    } finally {
      setBusyAll(false)
    }
  }

  const item =
    'w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs text-citrus-dark hover:bg-citrus-pink-light/60 dark:text-citrus-night-text dark:hover:bg-citrus-night-elev disabled:opacity-50'

  return (
    <div
      ref={ref}
      className="column-menu fixed z-50 flex flex-col rounded-lg border border-citrus-border bg-citrus-card shadow-lg overflow-hidden dark:border-citrus-night-border dark:bg-citrus-night-card"
      style={{ top: anchor.bottom + 4, left, width: MENU_W }}
    >
      <div className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wide text-citrus-muted border-b border-citrus-border/60 dark:text-citrus-night-muted dark:border-citrus-night-border/60 truncate">
        {col.original}
      </div>

      <button className={item} onClick={pivotDistinct} disabled={loading}>
        {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" /> : <ArrowRightLeft className="w-3.5 h-3.5 shrink-0 text-citrus-pink" />}
        Distinct values → scratchpad
      </button>
      <button className={item} onClick={pivotAll} disabled={busyAll}>
        {busyAll ? <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" /> : <ArrowRightLeft className="w-3.5 h-3.5 shrink-0 text-citrus-pink" />}
        All values → scratchpad
      </button>

      <div className="border-t border-citrus-border/60 dark:border-citrus-night-border/60" />
      <button className={item} onClick={() => setShowValues((v) => !v)}>
        <Filter className="w-3.5 h-3.5 shrink-0 text-citrus-pink" />
        Filter to value…
      </button>

      {showValues && (
        <div className="flex flex-col border-t border-citrus-border/60 dark:border-citrus-night-border/60">
          <input
            autoFocus
            value={needle}
            onChange={(e) => setNeedle(e.target.value)}
            placeholder="find a value…"
            className="mx-2 my-1.5 px-2 py-1 text-[11px] rounded border border-citrus-border bg-citrus-cream text-citrus-dark outline-none focus:border-citrus-pink dark:border-citrus-night-border dark:bg-citrus-night dark:text-citrus-night-text"
          />
          <div className="max-h-52 overflow-auto scrollbar-none">
            {loading && (
              <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-citrus-muted dark:text-citrus-night-muted">
                <Loader2 className="w-3 h-3 animate-spin" /> loading…
              </div>
            )}
            {!loading && shown.length === 0 && (
              <div className="px-3 py-2 text-[11px] text-citrus-muted dark:text-citrus-night-muted">no values</div>
            )}
            {shown.map((r) => (
              <button
                key={r.val}
                className="w-full flex items-center justify-between gap-2 px-3 py-1 text-left text-[11px] font-mono hover:bg-citrus-pink-light/50 dark:hover:bg-citrus-night-elev"
                onClick={() => {
                  onAddFilter({ col: col.name, op: 'eq', value: r.val })
                  onClose()
                }}
                title="Filter rows to this value"
              >
                <span className="truncate text-citrus-dark dark:text-citrus-night-text">{r.val === '' ? '∅ (empty)' : r.val}</span>
                <span className="shrink-0 text-citrus-muted dark:text-citrus-night-muted">{r.cnt.toLocaleString()}</span>
              </button>
            ))}
            {truncated && (
              <div className="px-3 py-1.5 text-[10px] text-citrus-muted dark:text-citrus-night-muted">
                <ListTree className="inline w-3 h-3 mr-1" />
                top {DISTINCT_LIMIT} shown
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
