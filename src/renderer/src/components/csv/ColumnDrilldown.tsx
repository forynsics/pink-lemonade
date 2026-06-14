import { useEffect, useState } from 'react'
import { ArrowRightLeft, Loader2, X } from 'lucide-react'
import type { CsvDoc } from '../../state/documents'
import type { CsvColumn, CsvDistinctRow, CsvFilter } from '../../state/csvTypes'

// Side panel: distinct values + counts for one column, with two pivot actions
// (distinct → new scratch tab, ALL values → new scratch tab) and click-to-filter.

const DISTINCT_LIMIT = 1000

export function ColumnDrilldown({
  doc,
  col,
  filters,
  onClose,
  onPivot,
  onAddFilter
}: {
  doc: CsvDoc
  col: CsvColumn
  filters: CsvFilter[]
  onClose: () => void
  onPivot: (values: string[], label: string) => void
  onAddFilter: (f: CsvFilter) => void
}): JSX.Element {
  const [rows, setRows] = useState<CsvDistinctRow[]>([])
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busyAll, setBusyAll] = useState(false)

  const label = `${doc.sourceName} · ${col.original}`

  useEffect(() => {
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
  }, [doc.tabId, col.name, filters])

  function pivotDistinct(): void {
    onPivot(
      rows.map((r) => r.val),
      label
    )
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
    'flex-1 inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-md text-[11px] font-bold transition-colors'

  return (
    <aside className="csv-drilldown flex flex-col w-72 shrink-0 border-l border-citrus-border bg-citrus-cream dark:border-citrus-night-border dark:bg-citrus-night">
      <div className="flex items-center justify-between px-3 py-2 border-b border-citrus-border dark:border-citrus-night-border">
        <div className="min-w-0">
          <div className="text-xs font-bold text-citrus-dark truncate dark:text-citrus-night-text">{col.original}</div>
          <div className="text-[10px] font-mono text-citrus-muted dark:text-citrus-night-muted">
            {loading ? 'loading…' : `${rows.length}${truncated ? '+' : ''} distinct`}
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
          title="Open distinct values in a new scratchpad tab"
        >
          <ArrowRightLeft className="w-3 h-3" /> Distinct
        </button>
        <button
          className={`${btn} border border-citrus-pink/40 text-citrus-pink hover:bg-citrus-pink-light dark:hover:bg-citrus-night-elev`}
          onClick={pivotAll}
          disabled={busyAll}
          title="Open ALL values (every row) in a new scratchpad tab"
        >
          {busyAll ? <Loader2 className="w-3 h-3 animate-spin" /> : <ArrowRightLeft className="w-3 h-3" />} All
        </button>
      </div>

      <div className="flex-1 overflow-auto scrollbar-none">
        {rows.map((r) => (
          <button
            key={r.val}
            className="w-full flex items-center justify-between gap-2 px-3 py-1 text-left text-[11px] font-mono hover:bg-citrus-pink-light/50 dark:hover:bg-citrus-night-elev"
            onClick={() => onAddFilter({ col: col.name, op: 'eq', value: r.val })}
            title="Filter rows to this value"
          >
            <span className="truncate text-citrus-dark dark:text-citrus-night-text">{r.val === '' ? '∅ (empty)' : r.val}</span>
            <span className="shrink-0 text-citrus-muted dark:text-citrus-night-muted">{r.cnt.toLocaleString()}</span>
          </button>
        ))}
        {truncated && (
          <div className="px-3 py-2 text-[10px] text-citrus-muted dark:text-citrus-night-muted">
            showing top {DISTINCT_LIMIT} — use “All” to pivot every value
          </div>
        )}
      </div>
    </aside>
  )
}
