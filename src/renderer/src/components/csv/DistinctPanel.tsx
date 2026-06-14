import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, NotebookPen, X } from 'lucide-react'
import type { CsvViewSource } from './CsvViewer'
import type { CsvColumn, CsvDistinctRow, CsvFilter } from '../../state/csvTypes'

// Side panel showing a column's distinct values + counts, so an analyst can read them while
// the CSV grid stays visible. Drag the left edge to widen it (shrinking the grid). Exports to
// a notepad tab: the distinct values, or every value.

const DISTINCT_LIMIT = 1000
const MIN_W = 220
const MAX_W = 760
const DEFAULT_W = 288

export function DistinctPanel({
  doc,
  col,
  filters,
  onClose,
  onPivot
}: {
  doc: CsvViewSource
  col: CsvColumn
  filters: CsvFilter[]
  onClose: () => void
  onPivot: (values: string[], label: string) => void
}): JSX.Element {
  const [rows, setRows] = useState<CsvDistinctRow[]>([])
  const [total, setTotal] = useState(0)
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busyAll, setBusyAll] = useState(false)
  const [width, setWidth] = useState(DEFAULT_W)

  const label = `${doc.sourceName} · ${col.original}`

  useEffect(() => {
    let live = true
    setLoading(true)
    window.api.csv
      .distinct(doc.tabId, col.name, filters, DISTINCT_LIMIT)
      .then((res) => {
        if (!live) return
        setRows(res.rows)
        setTotal(res.total)
        setTruncated(res.truncated)
      })
      .finally(() => live && setLoading(false))
    return () => {
      live = false
    }
  }, [doc.tabId, col.name, filters])

  // Drag the left edge to resize (dragging left → wider).
  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    const onMove = (ev: MouseEvent): void => {
      setWidth(Math.min(MAX_W, Math.max(MIN_W, startW - (ev.clientX - startX))))
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [width])

  function pivotDistinct(): void {
    onPivot(rows.map((r) => r.val), label)
  }

  async function pivotAll(): Promise<void> {
    setBusyAll(true)
    try {
      const res = await window.api.csv.values(doc.tabId, col.name, filters)
      onPivot(res.values, label)
    } finally {
      setBusyAll(false)
    }
  }

  const btn =
    'flex-1 inline-flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-[11px] font-bold transition-colors'

  return (
    <aside
      className="csv-distinct relative flex flex-col shrink-0 border-l border-citrus-border bg-citrus-cream dark:border-citrus-night-border dark:bg-citrus-night"
      style={{ width }}
    >
      {/* left-edge resize handle */}
      <div
        onMouseDown={startResize}
        className="csv-distinct__resize absolute top-0 left-0 h-full w-1.5 -ml-0.5 cursor-col-resize hover:bg-citrus-pink/40 z-10"
        title="Drag to resize"
      />

      <div className="flex items-center justify-between px-3 py-2 border-b border-citrus-border dark:border-citrus-night-border">
        <div className="min-w-0">
          <div className="text-xs font-bold text-citrus-dark truncate dark:text-citrus-night-text">{col.original}</div>
          <div className="text-[10px] font-mono text-citrus-muted dark:text-citrus-night-muted">
            {loading ? 'loading…' : `${total.toLocaleString()} distinct`}
          </div>
        </div>
        <button onClick={onClose} className="text-citrus-muted hover:text-citrus-pink" title="Close">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex gap-1.5 px-3 py-2 border-b border-citrus-border/60 dark:border-citrus-night-border/60">
        <button
          className={`${btn} bg-citrus-pink text-white hover:bg-citrus-pink-hover`}
          onClick={pivotDistinct}
          disabled={loading || rows.length === 0}
          title="Open these distinct values in a new notepad tab"
        >
          <NotebookPen className="w-3.5 h-3.5" /> Distinct
        </button>
        <button
          className={`${btn} border border-citrus-pink/40 text-citrus-pink hover:bg-citrus-pink-light dark:hover:bg-citrus-night-elev`}
          onClick={pivotAll}
          disabled={busyAll}
          title="Open every value (all rows) in a new notepad tab"
        >
          {busyAll ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <NotebookPen className="w-3.5 h-3.5" />} All
        </button>
      </div>

      <div className="flex-1 overflow-auto scrollbar-none">
        {rows.map((r) => (
          <div key={r.val} className="w-full flex items-center justify-between gap-2 px-3 py-1 text-[11px] font-mono">
            <span className="truncate text-citrus-dark dark:text-citrus-night-text">{r.val === '' ? '∅ (empty)' : r.val}</span>
            <span className="shrink-0 text-citrus-muted dark:text-citrus-night-muted">{r.cnt.toLocaleString()}</span>
          </div>
        ))}
        {truncated && (
          <div className="px-3 py-2 text-[10px] text-citrus-muted dark:text-citrus-night-muted">
            showing top {DISTINCT_LIMIT.toLocaleString()} of {total.toLocaleString()} — use “All” to export every value
          </div>
        )}
      </div>
    </aside>
  )
}
