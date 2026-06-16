import { useEffect, useMemo, useRef, useState } from 'react'
import { Crosshair, X } from 'lucide-react'
import type { CsvColumn } from '../../state/csvTypes'
import { parseIntelText, type SweepKind } from '../../state/sweepIntel'

const KIND_CHIP: Record<SweepKind, string> = {
  ipv4: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300',
  domain: 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300',
  hash: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
}

/**
 * Intel Sweep dialog: paste an intel set (IPs / domains / hashes), pick which columns to scan, and
 * run a sweep that marks matching rows as sightings. The paste box classifies + normalizes each line
 * live (accepted / normalized before→after / skipped with a reason) so bad input is caught up front.
 */
export function SweepDialog({
  tabId,
  columns,
  sourceName,
  onClose,
  onSwept,
  onSeeSightings
}: {
  tabId: string
  columns: CsvColumn[]
  sourceName: string
  onClose: () => void
  onSwept: () => void
  /** Open the Sightings panel (offered after a run, while the indicator list is unchanged). */
  onSeeSightings: () => void
}): JSX.Element {
  const [text, setText] = useState('')
  // The exact paste text of the last successful run. While it still matches, re-running would be
  // a no-op, so the primary action becomes "See sightings"; editing the list flips it back.
  const [lastRunText, setLastRunText] = useState<string | null>(null)
  const [allColumns, setAllColumns] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(() => new Set(columns.map((c) => c.name)))
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<{ scanned: number; max: number; sightings: number } | null>(null)
  const [result, setResult] = useState<{ sightings: number; hits: number } | { canceled: true } | null>(null)
  const reqRef = useRef(0)

  const parsed = useMemo(() => parseIntelText(text), [text])
  const colCount = allColumns ? columns.length : selected.size
  const canRun = parsed.entries.length > 0 && colCount > 0 && !running

  // Stream scan progress for the active sweep request only.
  useEffect(() => {
    return window.api.csv.onSweepProgress((p) => {
      if (p.tabId === tabId && p.reqId === reqRef.current) {
        setProgress({ scanned: p.scanned, max: p.max, sightings: p.sightings })
      }
    })
  }, [tabId])

  function toggleCol(name: string): void {
    setSelected((s) => {
      const n = new Set(s)
      if (n.has(name)) n.delete(name)
      else n.add(name)
      return n
    })
  }

  async function run(): Promise<void> {
    if (!canRun) return
    const cols = allColumns ? undefined : columns.filter((c) => selected.has(c.name)).map((c) => c.name)
    const reqId = ++reqRef.current
    setRunning(true)
    setResult(null)
    setProgress({ scanned: 0, max: 0, sightings: 0 })
    const res = await window.api.csv.sweep(tabId, reqId, parsed.entries, cols)
    setRunning(false)
    setResult(res)
    if (!('canceled' in res)) {
      onSwept() // refresh the grid's sighting markers + count
      setLastRunText(text) // re-running the same list is now redundant → offer "See sightings"
    }
  }

  function cancel(): void {
    void window.api.csv.sweepCancel(tabId)
  }

  const pct = progress && progress.max > 0 ? Math.min(100, Math.round((progress.scanned / progress.max) * 100)) : 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-[34rem] max-w-[92vw] flex-col rounded-xl border border-citrus-border bg-citrus-card shadow-lg dark:border-citrus-night-border dark:bg-citrus-night-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-citrus-border px-5 py-3 dark:border-citrus-night-border">
          <Crosshair className="h-4 w-4 text-red-500 dark:text-red-400" />
          <span className="text-sm font-bold text-citrus-dark dark:text-citrus-night-text">Intel Sweep</span>
          <span className="truncate text-xs text-citrus-muted dark:text-citrus-night-muted">· {sourceName}</span>
          <button onClick={onClose} className="ml-auto text-citrus-muted hover:text-citrus-pink dark:text-citrus-night-muted">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-auto px-5 py-3">
          {/* Paste box */}
          <label className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-citrus-muted dark:text-citrus-night-muted">
            Indicators to sweep for
          </label>
          <textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              setResult(null) // a changed list invalidates the last run's result
            }}
            placeholder={'Paste IPs, domains, or hashes — one per line.\nURLs are reduced to their domain; defanged values (1[.]2[.]3[.]4) are fine.'}
            className="h-28 w-full resize-y rounded-md border border-citrus-border bg-citrus-cream px-2 py-1.5 font-mono text-xs text-citrus-dark outline-none focus:border-citrus-pink dark:border-citrus-night-border dark:bg-citrus-night dark:text-citrus-night-text"
          />

          {/* Live parse feedback */}
          {text.trim() !== '' && (
            <div className="mt-1.5">
              <div className="text-[11px] text-citrus-muted dark:text-citrus-night-muted">
                <strong className="text-citrus-dark dark:text-citrus-night-text">{parsed.entries.length}</strong> to sweep ·{' '}
                {parsed.counts.ipv4} IP · {parsed.counts.domain} domain · {parsed.counts.hash} hash
                {parsed.counts.skipped > 0 && (
                  <span className="text-red-600 dark:text-red-400"> · {parsed.counts.skipped} skipped</span>
                )}
              </div>
              <div className="mt-1 max-h-28 overflow-auto rounded border border-citrus-border/60 dark:border-citrus-night-border/60">
                {parsed.lines.map((l, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2 px-2 py-0.5 text-[11px] font-mono odd:bg-citrus-sand/30 dark:odd:bg-citrus-night-elev/30"
                  >
                    {l.status === 'ok' ? (
                      <>
                        <span className={`shrink-0 rounded px-1 text-[9px] font-bold uppercase ${KIND_CHIP[l.kind]}`}>{l.kind}</span>
                        <span className="truncate text-citrus-dark dark:text-citrus-night-text">{l.value}</span>
                        {l.note && <span className="shrink-0 text-citrus-muted dark:text-citrus-night-muted">({l.note})</span>}
                      </>
                    ) : (
                      <>
                        <span className="shrink-0 rounded bg-red-100 px-1 text-[9px] font-bold uppercase text-red-700 dark:bg-red-900/40 dark:text-red-300">
                          skip
                        </span>
                        <span className="truncate text-citrus-muted line-through dark:text-citrus-night-muted">{l.original}</span>
                        <span className="ml-auto shrink-0 text-red-600 dark:text-red-400">{l.reason}</span>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Column scope */}
          <div className="mt-3">
            <label className="flex cursor-pointer items-center gap-2 text-xs text-citrus-dark dark:text-citrus-night-text">
              <input type="checkbox" checked={allColumns} onChange={(e) => setAllColumns(e.target.checked)} />
              Scan <strong>all columns</strong>
              <span className="text-citrus-muted dark:text-citrus-night-muted">(slower, catches IOCs anywhere)</span>
            </label>
            {!allColumns && (
              <div className="mt-1 grid max-h-32 grid-cols-2 gap-x-3 overflow-auto rounded border border-citrus-border/60 p-2 dark:border-citrus-night-border/60">
                {columns.map((c) => (
                  <label key={c.name} className="flex cursor-pointer items-center gap-1.5 text-[11px] text-citrus-dark dark:text-citrus-night-text">
                    <input type="checkbox" checked={selected.has(c.name)} onChange={() => toggleCol(c.name)} />
                    <span className="truncate" title={c.original}>{c.original}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* Progress / result */}
          {running && (
            <div className="mt-3">
              <div className="mb-1 flex items-center justify-between text-[11px] text-citrus-muted dark:text-citrus-night-muted">
                <span>
                  Scanning… {progress ? `${progress.scanned.toLocaleString()}${progress.max ? ` / ${progress.max.toLocaleString()}` : ''}` : ''}
                </span>
                <span className="text-red-600 dark:text-red-400">{progress?.sightings.toLocaleString() ?? 0} sightings</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded bg-citrus-sand dark:bg-citrus-night-elev">
                <div className="h-full bg-red-500 transition-all dark:bg-red-400" style={{ width: `${pct}%` }} />
              </div>
            </div>
          )}
          {result && !running && (
            <div className="mt-3 text-xs">
              {'canceled' in result ? (
                <span className="text-citrus-muted dark:text-citrus-night-muted">Sweep canceled.</span>
              ) : (
                <span className="text-citrus-dark dark:text-citrus-night-text">
                  Found <strong className="text-red-600 dark:text-red-400">{result.sightings.toLocaleString()}</strong>{' '}
                  {result.sightings === 1 ? 'sighting' : 'sightings'} ({result.hits.toLocaleString()} total hits).
                </span>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-citrus-border px-5 py-3 dark:border-citrus-night-border">
          {running ? (
            <button
              onClick={cancel}
              className="rounded-md border border-citrus-border px-3 py-1 text-[11px] font-bold text-citrus-muted hover:border-red-500/40 hover:text-red-600 dark:border-citrus-night-border dark:text-citrus-night-muted"
            >
              Cancel
            </button>
          ) : (
            <>
              <button
                onClick={onClose}
                className="rounded-md border border-citrus-border px-3 py-1 text-[11px] font-bold text-citrus-muted hover:text-citrus-pink hover:border-citrus-pink/40 dark:border-citrus-night-border dark:text-citrus-night-muted"
              >
                Close
              </button>
              {lastRunText !== null && lastRunText === text ? (
                <button
                  onClick={onSeeSightings}
                  className="inline-flex items-center gap-1 rounded-md bg-red-500 px-3 py-1 text-[11px] font-bold text-white hover:bg-red-600"
                  title="Open the Sightings panel (the list is unchanged — no need to re-sweep)"
                >
                  <Crosshair className="h-3.5 w-3.5" />
                  See sightings
                </button>
              ) : (
                <button
                  onClick={() => void run()}
                  disabled={!canRun}
                  className="inline-flex items-center gap-1 rounded-md bg-red-500 px-3 py-1 text-[11px] font-bold text-white hover:bg-red-600 disabled:opacity-40 dark:bg-red-500 dark:hover:bg-red-600"
                  title={parsed.entries.length === 0 ? 'Add some indicators first' : colCount === 0 ? 'Pick at least one column' : `Sweep ${parsed.entries.length} indicator(s) across ${colCount} column(s)`}
                >
                  <Crosshair className="h-3.5 w-3.5" />
                  Run sweep
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
