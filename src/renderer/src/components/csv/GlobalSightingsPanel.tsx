import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Crosshair, FileText, Loader2, Trash2, X } from 'lucide-react'
import { kindChip } from '../../state/indicatorKinds'
import type { CsvSightingGroup } from '../../state/csvTypes'

// Workspace-wide sightings results — the cross-file "where is it?" view (à la Notepad++ Find-in-files).
// After a sweep across many sources, the per-file Sightings panel shows 0 on a file with no hits; this
// rolls up EVERY file at once, grouped by indicator → the files it was seen in. Clicking a file jumps
// the grid to that source and focuses the matching rows. Loads its own rollup; the jump lives in App.

const MIN_W = 260
const MAX_W = 820
const DEFAULT_W = 340

export function GlobalSightingsPanel({
  open,
  wsId,
  reloadKey,
  onPivot,
  onCleared,
  onClose
}: {
  open: boolean
  wsId: string | null
  /** Bumps after any sweep (or external sighting change) so the rollup reloads. */
  reloadKey: number
  /** Jump to a file + show exactly the matching rows (App's pivotToEvidence → a rowid filter). */
  onPivot: (sourceId: number, rids: number[]) => void
  /** Called after this panel clears sightings (false positives) so App refreshes grids + this view. */
  onCleared: () => void
  onClose: () => void
}): JSX.Element | null {
  const [groups, setGroups] = useState<CsvSightingGroup[]>([])
  const [loading, setLoading] = useState(true)
  const [needle, setNeedle] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [width, setWidth] = useState(DEFAULT_W)

  useEffect(() => {
    if (!open || !wsId) return
    let live = true
    setLoading(true)
    void window.api.csv.sightingsAll(wsId).then((g) => {
      if (!live) return
      setGroups(g)
      setLoading(false)
    })
    return () => {
      live = false
    }
  }, [open, wsId, reloadKey])

  const shown = useMemo(() => {
    const n = needle.trim().toLowerCase()
    if (n === '') return groups
    return groups.filter(
      (g) => g.indicator.toLowerCase().includes(n) || g.sources.some((s) => s.sourceName.toLowerCase().includes(n))
    )
  }, [groups, needle])

  const fileCount = useMemo(() => {
    const ids = new Set<number>()
    for (const g of groups) for (const s of g.sources) ids.add(s.sourceId)
    return ids.size
  }, [groups])

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

  function toggle(key: string): void {
    setCollapsed((c) => {
      const n = new Set(c)
      if (n.has(key)) n.delete(key)
      else n.add(key)
      return n
    })
  }

  // Clear sightings (false positives): one file's hits for an indicator, or every file's. The panel
  // owns the IPC (it has wsId + the per-file sourceIds); onCleared bumps App so grids + this view sync.
  async function clearFile(sourceId: number, indicator: string): Promise<void> {
    if (!wsId) return
    await window.api.csv.sightingClear(wsId, sourceId, { indicator })
    onCleared()
  }
  async function clearIndicator(g: CsvSightingGroup): Promise<void> {
    if (!wsId) return
    await Promise.all(g.sources.map((s) => window.api.csv.sightingClear(wsId, s.sourceId, { indicator: g.indicator })))
    onCleared()
  }

  if (!open) return null

  return (
    <aside
      className="csv-global-sightings relative flex flex-col shrink-0 border-l border-citrus-border bg-citrus-cream dark:border-citrus-night-border dark:bg-citrus-night"
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
          <div className="text-xs font-bold text-citrus-dark dark:text-citrus-night-text">Sightings — all files</div>
          <div className="font-mono text-[10px] text-citrus-muted dark:text-citrus-night-muted">
            {loading ? 'loading…' : `${groups.length.toLocaleString()} indicators · ${fileCount.toLocaleString()} files`}
          </div>
        </div>
        <button onClick={onClose} className="ml-auto text-citrus-muted hover:text-citrus-pink" title="Close">
          <X className="h-4 w-4" />
        </button>
      </div>

      <input
        value={needle}
        onChange={(e) => setNeedle(e.target.value)}
        placeholder="find an indicator or file…"
        className="mx-3 mt-2 rounded border border-citrus-border bg-citrus-cream px-2 py-1 text-[11px] text-citrus-dark outline-none focus:border-citrus-pink dark:border-citrus-night-border dark:bg-citrus-night dark:text-citrus-night-text"
      />
      <div className="mx-3 mb-1.5 mt-1 text-[10px] text-citrus-muted dark:text-citrus-night-muted">
        click a file to jump to its rows
      </div>

      <div className="flex-1 overflow-auto scrollbar-none">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-[11px] text-citrus-muted dark:text-citrus-night-muted">
            <Loader2 className="h-4 w-4 animate-spin text-citrus-pink" /> loading…
          </div>
        ) : groups.length === 0 ? (
          <div className="px-3 py-8 text-center text-[11px] text-citrus-muted dark:text-citrus-night-muted">
            No sightings yet — run an Intel Sweep.
          </div>
        ) : shown.length === 0 ? (
          <div className="px-3 py-8 text-center text-[11px] text-citrus-muted dark:text-citrus-night-muted">No match.</div>
        ) : (
          shown.map((g) => {
            const key = `${g.kind}:${g.indicator}`
            const isCollapsed = collapsed.has(key)
            return (
              <div key={key} className="group/ind border-b border-citrus-border/40 dark:border-citrus-night-border/40">
                <div className="flex items-center gap-1.5 px-2 py-1 hover:bg-citrus-pink-light/40 dark:hover:bg-citrus-night-elev/50">
                  <button onClick={() => toggle(key)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left" title={isCollapsed ? 'Expand' : 'Collapse'}>
                    {isCollapsed ? (
                      <ChevronRight className="h-3 w-3 shrink-0 text-citrus-muted dark:text-citrus-night-muted" />
                    ) : (
                      <ChevronDown className="h-3 w-3 shrink-0 text-citrus-muted dark:text-citrus-night-muted" />
                    )}
                    <span className={`shrink-0 rounded px-1 text-[9px] font-bold uppercase ${kindChip(g.kind)}`}>{g.kind}</span>
                    <span className="truncate font-mono text-[11px] font-bold text-citrus-dark dark:text-citrus-night-text" title={g.indicator}>
                      {g.indicator}
                    </span>
                    <span className="ml-auto shrink-0 text-[10px] text-citrus-muted dark:text-citrus-night-muted">
                      {g.total.toLocaleString()} {g.total === 1 ? 'row' : 'rows'} · {g.sources.length} {g.sources.length === 1 ? 'file' : 'files'}
                    </span>
                  </button>
                  <button
                    onClick={() => void clearIndicator(g)}
                    className="shrink-0 text-citrus-muted/0 group-hover/ind:text-citrus-muted hover:!text-red-600 dark:group-hover/ind:text-citrus-night-muted"
                    title={`Clear all sightings of ${g.indicator} (false positive)`}
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
                {!isCollapsed &&
                  g.sources.map((s) => (
                    <div key={s.sourceId} className="group/file flex items-center gap-2 py-1 pl-7 pr-2 text-[11px] hover:bg-red-500/10">
                      <button
                        onClick={() => onPivot(s.sourceId, s.rids)}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                        title={`Jump to ${s.count} matching row${s.count === 1 ? '' : 's'} in ${s.sourceName}`}
                      >
                        <FileText className="h-3 w-3 shrink-0 text-citrus-muted group-hover/file:text-red-600 dark:text-citrus-night-muted dark:group-hover/file:text-red-400" />
                        <span className="truncate text-citrus-dark dark:text-citrus-night-text" title={s.sourceName}>
                          {s.sourceName}
                        </span>
                        <span className="ml-auto shrink-0 font-mono text-citrus-muted group-hover/file:text-red-600 dark:text-citrus-night-muted dark:group-hover/file:text-red-400">
                          {s.count.toLocaleString()}
                        </span>
                      </button>
                      <button
                        onClick={() => void clearFile(s.sourceId, g.indicator)}
                        className="shrink-0 text-citrus-muted/0 group-hover/file:text-citrus-muted hover:!text-red-600 dark:group-hover/file:text-citrus-night-muted"
                        title={`Clear ${g.indicator} sightings in ${s.sourceName}`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
              </div>
            )
          })
        )}
      </div>
    </aside>
  )
}
