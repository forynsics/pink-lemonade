import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ChevronDown, Crosshair, FileUp, ListChecks, ShieldAlert, X } from 'lucide-react'
import type { CsvColumn } from '../../state/csvTypes'
import type { WatchlistInfo } from '../../state/enrichTypes'
import { parseIntelText } from '../../state/sweepIntel'
import { INDICATOR_KINDS, kindChip } from '../../state/indicatorKinds'

// Watchlist kinds map onto sweep kinds (asn has no sweep matcher, so those lists are filtered out).
const WL_CHIP: Record<string, string> = { ip: kindChip('ipv4'), domain: kindChip('domain'), hash: kindChip('hash') }

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
  onSeeSightings,
  existingCount,
  initialText,
  intelDbPath
}: {
  tabId: string
  columns: CsvColumn[]
  sourceName: string
  onClose: () => void
  onSwept: () => void
  /** Open the Sightings panel (offered after a run, while the indicator list is unchanged). */
  onSeeSightings: () => void
  /** Sightings already on this source — drives the Add-vs-Replace choice (avoids silent wipes). */
  existingCount: number
  /** Pre-fill the indicator box (used by the Intel-tab → sweep pivot). */
  initialText?: string
  /** This workspace's Intel DB — enables the "Flagged" source (indicators VT marked Malicious). */
  intelDbPath?: string
}): JSX.Element {
  const [text, setText] = useState(initialText ?? '')
  // The exact paste text of the last successful run. While it still matches, re-running would be
  // a no-op, so the primary action becomes "See sightings"; editing the list flips it back.
  const [lastRunText, setLastRunText] = useState<string | null>(null)
  // With prior sightings, default to keeping them (Add) so a re-sweep never silently wipes progress.
  const [mode, setMode] = useState<'replace' | 'add'>(existingCount > 0 ? 'add' : 'replace')
  // Declared-filename mode: when on, every line is treated as a file name (no auto-detection), so an
  // ambiguous kind that can't be sniffed (evil.exe vs a domain) enters via an explicit declaration.
  const [filenameMode, setFilenameMode] = useState(false)
  const [allColumns, setAllColumns] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(() => new Set(columns.map((c) => c.name)))
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<{ scanned: number; max: number; sightings: number } | null>(null)
  const [result, setResult] = useState<{ sightings: number; hits: number } | { canceled: true } | null>(null)
  const reqRef = useRef(0)

  // Intel sources beyond pasting: saved watchlists + a file. All three funnel into the textarea
  // (the single source of truth), so the existing parse/preview/dedup/run path is unchanged and you
  // can stack sources (a watchlist + a file + a few extra pasted lines) and still edit the result.
  const [watchlists, setWatchlists] = useState<WatchlistInfo[]>([])
  const [wlOpen, setWlOpen] = useState(false)
  const [loadNote, setLoadNote] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void window.api.watchlist.list().then((ws) => {
      // Only ip/domain/hash lists are sweepable (no ASN matcher).
      if (live) setWatchlists(ws.filter((w) => w.kind === 'ip' || w.kind === 'domain' || w.kind === 'hash'))
    })
    return () => {
      live = false
    }
  }, [])

  // Append loaded indicators to whatever's in the box (newline-joined), invalidating the last result.
  function appendIntel(more: string): void {
    const add = more.trim()
    if (!add) return
    setText((t) => (t.trim() === '' ? add : `${t.replace(/\s*$/, '')}\n${add}`))
    setResult(null)
    setLoadNote(null)
  }
  async function loadWatchlist(w: WatchlistInfo): Promise<void> {
    setWlOpen(false)
    const entries = await window.api.watchlist.entries(w.id)
    if (entries.length === 0) {
      setLoadNote(`"${w.name}" is empty`)
      return
    }
    appendIntel(entries.join('\n'))
  }
  async function loadFile(): Promise<void> {
    const f = await window.api.openFile()
    if (!f) return
    if (f.tooLarge) {
      setLoadNote(`${f.name} is too large to load as a watchlist`)
      return
    }
    // Files are often CSV/space-delimited — tokenize any separator to one indicator per line.
    appendIntel(f.content.split(/[\s,;]+/).filter(Boolean).join('\n'))
  }
  // Pull every indicator VirusTotal flagged Malicious from this workspace's Intel DB (the provider
  // stores the verdict, so it's a straight filter — no re-lookup, no quota).
  async function loadFlagged(): Promise<void> {
    if (!intelDbPath) {
      setLoadNote('No Intel DB linked to this workspace')
      return
    }
    const rows = await window.api.enrich.cacheDump(intelDbPath)
    const flagged = [...new Set(rows.filter((r) => r.fields?.['VT Verdict'] === 'Malicious').map((r) => r.indicator))]
    if (flagged.length === 0) {
      setLoadNote('No VirusTotal-flagged (Malicious) indicators in this Intel DB yet')
      return
    }
    appendIntel(flagged.join('\n'))
  }

  const parsed = useMemo(() => parseIntelText(text, filenameMode ? 'filename' : 'classify'), [text, filenameMode])
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
    const res = await window.api.csv.sweep(tabId, reqId, parsed.entries, cols, existingCount > 0 ? mode : 'replace')
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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={running ? undefined : onClose}
    >
      <div
        className="flex max-h-[85vh] w-[34rem] max-w-[92vw] flex-col rounded-xl border border-citrus-border bg-citrus-card shadow-lg dark:border-citrus-night-border dark:bg-citrus-night-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-citrus-border px-5 py-3 dark:border-citrus-night-border">
          <Crosshair className="h-4 w-4 text-red-500 dark:text-red-400" />
          <span className="text-sm font-bold text-citrus-dark dark:text-citrus-night-text">Intel Sweep</span>
          <span className="truncate text-xs text-citrus-muted dark:text-citrus-night-muted">· {sourceName}</span>
          {!running && (
            <button onClick={onClose} className="ml-auto text-citrus-muted hover:text-citrus-pink dark:text-citrus-night-muted">
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        <div className="flex-1 overflow-auto px-5 py-3">
          {/* Indicator sources: paste (the box) + load from a watchlist / file */}
          <div className="mb-1 flex items-center gap-2">
            <span className="text-[11px] font-bold uppercase tracking-wide text-citrus-muted dark:text-citrus-night-muted">
              Indicators to sweep for
            </span>
            <div className="ml-auto flex items-center gap-1.5">
              <div className="relative">
                <button
                  onClick={() => setWlOpen((o) => !o)}
                  disabled={watchlists.length === 0}
                  className="inline-flex items-center gap-1 rounded-md border border-citrus-border px-1.5 py-0.5 text-[10px] font-semibold text-citrus-dark hover:border-citrus-pink/40 hover:text-citrus-pink disabled:opacity-40 dark:border-citrus-night-border dark:text-citrus-night-text"
                  title={watchlists.length === 0 ? 'No IP / domain / hash watchlists yet' : 'Load indicators from a saved watchlist'}
                >
                  <ListChecks className="h-3 w-3" /> Watchlist <ChevronDown className="h-2.5 w-2.5" />
                </button>
                {wlOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setWlOpen(false)} />
                    <div className="absolute right-0 top-full z-50 mt-1 flex max-h-60 w-56 flex-col overflow-auto rounded-lg border border-citrus-border bg-citrus-card py-1 shadow-lg dark:border-citrus-night-border dark:bg-citrus-night-card">
                      {watchlists.map((w) => (
                        <button
                          key={w.id}
                          onClick={() => void loadWatchlist(w)}
                          className="flex items-center gap-2 px-3 py-1.5 text-left text-[11px] hover:bg-citrus-pink-light/60 dark:hover:bg-citrus-night-elev"
                        >
                          <span className={`shrink-0 rounded px-1 text-[9px] font-bold uppercase ${WL_CHIP[w.kind] ?? ''}`}>{w.kind}</span>
                          <span className="truncate text-citrus-dark dark:text-citrus-night-text">{w.name}</span>
                          <span className="ml-auto shrink-0 text-citrus-muted dark:text-citrus-night-muted">{w.count.toLocaleString()}</span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
              <button
                onClick={() => void loadFile()}
                className="inline-flex items-center gap-1 rounded-md border border-citrus-border px-1.5 py-0.5 text-[10px] font-semibold text-citrus-dark hover:border-citrus-pink/40 hover:text-citrus-pink dark:border-citrus-night-border dark:text-citrus-night-text"
                title="Load indicators from a .txt or .csv file"
              >
                <FileUp className="h-3 w-3" /> File
              </button>
              {intelDbPath && (
                <button
                  onClick={() => void loadFlagged()}
                  className="inline-flex items-center gap-1 rounded-md border border-citrus-border px-1.5 py-0.5 text-[10px] font-semibold text-citrus-dark hover:border-red-500/40 hover:text-red-600 dark:border-citrus-night-border dark:text-citrus-night-text"
                  title="Load indicators VirusTotal flagged Malicious from this workspace's Intel DB"
                >
                  <ShieldAlert className="h-3 w-3" /> Flagged
                </button>
              )}
            </div>
          </div>
          <textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              setResult(null) // a changed list invalidates the last run's result
            }}
            placeholder={'Paste IPs, domains, or hashes — one per line, or load from a watchlist / file above.\nURLs are reduced to their domain; defanged values (1[.]2[.]3[.]4) are fine.'}
            className="h-28 w-full resize-y rounded-md border border-citrus-border bg-citrus-cream px-2 py-1.5 font-mono text-xs text-citrus-dark outline-none focus:border-citrus-pink dark:border-citrus-night-border dark:bg-citrus-night dark:text-citrus-night-text"
          />
          {loadNote && <div className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">{loadNote}</div>}

          <label className="mt-2 flex cursor-pointer items-center gap-2 text-[11px] text-citrus-dark dark:text-citrus-night-text">
            <input
              type="checkbox"
              checked={filenameMode}
              onChange={(e) => {
                setFilenameMode(e.target.checked)
                setResult(null)
              }}
            />
            Treat each line as a <strong>file name</strong>
            <span className="text-citrus-muted dark:text-citrus-night-muted">(skips IP/domain/hash auto-detection)</span>
          </label>

          {/* Live parse feedback */}
          {text.trim() !== '' && (
            <div className="mt-1.5">
              <div className="text-[11px] text-citrus-muted dark:text-citrus-night-muted">
                <strong className="text-citrus-dark dark:text-citrus-night-text">{parsed.entries.length}</strong> to sweep
                {INDICATOR_KINDS.filter((k) => parsed.counts[k.id] > 0).map((k) => (
                  <span key={k.id}> · {parsed.counts[k.id]} {k.label}</span>
                ))}
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
                        <span className={`shrink-0 rounded px-1 text-[9px] font-bold uppercase ${kindChip(l.kind)}`}>{l.kind}</span>
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

          {/* Existing sightings: keep or replace (so a re-sweep never wipes progress silently) */}
          {existingCount > 0 && (
            <div className="mt-3 rounded-md border border-amber-400/50 bg-amber-50 px-2.5 py-2 dark:border-amber-400/30 dark:bg-amber-900/15">
              <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold text-amber-700 dark:text-amber-300">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                This source already has {existingCount.toLocaleString()} {existingCount === 1 ? 'sighting' : 'sightings'}
              </div>
              <label className="flex cursor-pointer items-start gap-2 py-0.5 text-[11px] text-citrus-dark dark:text-citrus-night-text">
                <input type="radio" className="mt-0.5" checked={mode === 'add'} onChange={() => setMode('add')} />
                <span>
                  <strong>Add</strong> to them — keep the existing sightings and add any new matches.
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-2 py-0.5 text-[11px] text-citrus-dark dark:text-citrus-night-text">
                <input type="radio" className="mt-0.5" checked={mode === 'replace'} onChange={() => setMode('replace')} />
                <span>
                  <strong>Replace</strong> — clear the existing {existingCount.toLocaleString()} first, then sweep fresh.
                </span>
              </label>
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
                  Scanning… <strong className="text-citrus-dark dark:text-citrus-night-text">{pct}%</strong>
                  {progress && progress.max > 0 && (
                    <span className="ml-1 font-mono">
                      ({progress.scanned.toLocaleString()} / {progress.max.toLocaleString()} rows)
                    </span>
                  )}
                </span>
                <span className="text-red-600 dark:text-red-400">{progress?.sightings.toLocaleString() ?? 0} sightings</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded bg-citrus-sand dark:bg-citrus-night-elev">
                <div className="h-full bg-red-500 transition-all dark:bg-red-400" style={{ width: `${pct}%` }} />
              </div>
              <div className="mt-1 text-[10px] text-citrus-muted dark:text-citrus-night-muted">
                Keep this open until it finishes — use Cancel to stop.
              </div>
            </div>
          )}
          {result && !running && (
            <div className="mt-3 text-xs">
              {'canceled' in result ? (
                <span className="text-citrus-muted dark:text-citrus-night-muted">Sweep canceled.</span>
              ) : (
                <span className="text-citrus-dark dark:text-citrus-night-text">
                  Matched <strong className="text-red-600 dark:text-red-400">{result.sightings.toLocaleString()}</strong>{' '}
                  {result.sightings === 1 ? 'row' : 'rows'} this sweep.
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
