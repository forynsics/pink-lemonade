import { useEffect, useMemo, useState } from 'react'
import { Crosshair, Loader2, Trash2, X } from 'lucide-react'

// Side panel: the per-indicator sighting rollup (what matched + how many rows), so you can zero in
// on one or several indicators (filter the grid) or clear false positives. Mirrors DistinctPanel's
// aside layout. Loads its own summary; the filter state + clearing live in CsvViewer.

const MIN_W = 240
const MAX_W = 760
const DEFAULT_W = 308

const KIND_CHIP: Record<string, string> = {
  ipv4: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300',
  domain: 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300',
  hash: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
}

interface SummaryRow {
  indicator: string
  kind: string
  count: number
}

export function SightingsPanel({
  wsId,
  sourceId,
  totalRows,
  reloadKey,
  activeIndicators,
  allActive,
  onToggleAll,
  onToggleIndicator,
  onClearAll,
  onClearIndicator,
  onClose
}: {
  wsId: string
  sourceId: number
  /** Distinct sighting rows (for the "show all" label) — overlaps mean this ≤ sum of per-indicator. */
  totalRows: number
  reloadKey: number
  activeIndicators: string[]
  allActive: boolean
  onToggleAll: () => void
  onToggleIndicator: (indicator: string) => void
  onClearAll: () => void
  onClearIndicator: (indicator: string) => void
  onClose: () => void
}): JSX.Element {
  const [rows, setRows] = useState<SummaryRow[]>([])
  const [loading, setLoading] = useState(true)
  const [needle, setNeedle] = useState('')
  const [width, setWidth] = useState(DEFAULT_W)

  useEffect(() => {
    let live = true
    setLoading(true)
    void window.api.csv.sightingSummary(wsId, sourceId).then((r) => {
      if (!live) return
      setRows(r)
      setLoading(false)
    })
    return () => {
      live = false
    }
  }, [wsId, sourceId, reloadKey])

  const shown = useMemo(() => {
    const n = needle.trim().toLowerCase()
    return n === '' ? rows : rows.filter((r) => r.indicator.toLowerCase().includes(n))
  }, [rows, needle])

  const active = new Set(activeIndicators)

  const startResize = (e: React.MouseEvent): void => {
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    const onMove = (ev: MouseEvent): void => setWidth(Math.min(MAX_W, Math.max(MIN_W, startW - (ev.clientX - startX))))
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <aside
      className="csv-sightings relative flex flex-col shrink-0 border-l border-citrus-border bg-citrus-cream dark:border-citrus-night-border dark:bg-citrus-night"
      style={{ width }}
    >
      <div
        onMouseDown={startResize}
        className="absolute top-0 left-0 z-30 -ml-1.5 h-full w-3 cursor-col-resize hover:bg-citrus-pink/40"
        title="Drag to resize"
      />

      <div className="flex items-center gap-2 border-b border-citrus-border px-3 py-2 dark:border-citrus-night-border">
        <Crosshair className="h-4 w-4 shrink-0 text-red-500 dark:text-red-400" />
        <div className="min-w-0">
          <div className="text-xs font-bold text-citrus-dark dark:text-citrus-night-text">Sightings</div>
          <div className="font-mono text-[10px] text-citrus-muted dark:text-citrus-night-muted">
            {loading ? 'loading…' : `${rows.length.toLocaleString()} indicators · ${totalRows.toLocaleString()} rows`}
          </div>
        </div>
        <button onClick={onClose} className="ml-auto text-citrus-muted hover:text-citrus-pink" title="Close">
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Show-all toggle + clear-all */}
      <div className="flex items-center gap-1.5 border-b border-citrus-border/60 px-3 py-2 dark:border-citrus-night-border/60">
        <button
          onClick={onToggleAll}
          className={`flex-1 rounded-md px-2 py-1 text-[11px] font-bold transition-colors ${
            allActive
              ? 'bg-red-500 text-white hover:bg-red-600'
              : 'border border-red-500/40 text-red-600 hover:bg-red-500/10 dark:text-red-400'
          }`}
          title={allActive ? 'Showing all sightings — click to show every row' : 'Show only rows with any sighting'}
        >
          {allActive ? 'Showing all sightings' : 'Show all sightings'}
        </button>
        <button
          onClick={onClearAll}
          disabled={rows.length === 0}
          className="inline-flex items-center gap-1 rounded-md border border-citrus-border px-2 py-1 text-[11px] font-semibold text-citrus-muted hover:border-red-500/40 hover:text-red-600 disabled:opacity-40 dark:border-citrus-night-border dark:text-citrus-night-muted"
          title="Clear every sighting from this source"
        >
          <Trash2 className="h-3 w-3" /> Clear all
        </button>
      </div>

      <input
        value={needle}
        onChange={(e) => setNeedle(e.target.value)}
        placeholder="find an indicator…"
        className="mx-3 my-2 rounded border border-citrus-border bg-citrus-cream px-2 py-1 text-[11px] text-citrus-dark outline-none focus:border-citrus-pink dark:border-citrus-night-border dark:bg-citrus-night dark:text-citrus-night-text"
      />

      <div className="flex-1 overflow-auto scrollbar-none">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-[11px] text-citrus-muted dark:text-citrus-night-muted">
            <Loader2 className="h-4 w-4 animate-spin text-citrus-pink" /> loading…
          </div>
        ) : rows.length === 0 ? (
          <div className="px-3 py-8 text-center text-[11px] text-citrus-muted dark:text-citrus-night-muted">
            No sightings yet — run an Intel Sweep.
          </div>
        ) : (
          shown.map((r) => {
            const on = !allActive && active.has(r.indicator)
            return (
              <div
                key={`${r.kind}:${r.indicator}`}
                className={`group flex items-center gap-2 px-3 py-1 text-[11px] font-mono ${
                  on ? 'bg-red-500/10' : 'hover:bg-citrus-pink-light/40 dark:hover:bg-citrus-night-elev/50'
                }`}
              >
                <button
                  onClick={() => onToggleIndicator(r.indicator)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  title={on ? `Showing ${r.indicator} — click to remove from filter` : `Zero in on ${r.indicator}`}
                >
                  <span className={`shrink-0 rounded px-1 text-[9px] font-bold uppercase ${KIND_CHIP[r.kind] ?? ''}`}>{r.kind}</span>
                  <span className={`truncate ${on ? 'font-bold text-red-600 dark:text-red-400' : 'text-citrus-dark dark:text-citrus-night-text'}`}>
                    {r.indicator}
                  </span>
                  <span className="ml-auto shrink-0 text-citrus-muted dark:text-citrus-night-muted">{r.count.toLocaleString()}</span>
                </button>
                <button
                  onClick={() => onClearIndicator(r.indicator)}
                  className="shrink-0 text-citrus-muted/0 group-hover:text-citrus-muted hover:!text-red-600 dark:group-hover:text-citrus-night-muted"
                  title={`Clear this indicator's sightings (false positive)`}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            )
          })
        )}
      </div>
    </aside>
  )
}
