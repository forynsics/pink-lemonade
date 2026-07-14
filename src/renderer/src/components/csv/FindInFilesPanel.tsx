import { useEffect, useMemo, useRef, useState } from 'react'
import { FileText, Loader2, Search, X } from 'lucide-react'

// Workspace-wide "Find in files" — type one arbitrary string, fan a CONTAINS (substring, case-
// insensitive) search across every source (or one group), and list which files contain it. Clicking
// a file jumps the grid to that source and focuses the matching rows. The free-string twin of the
// Sightings panel (which is fed only by typed-IOC sweeps); backend is csv:findInFiles, jump in App.

const MIN_W = 280
const MAX_W = 820
const DEFAULT_W = 360
const ALL = '__all__'
const UNGROUPED = '__ungrouped__'

interface Hit {
  sourceId: number
  name: string
  group: string | null
  rowCount: number
  matchCount: number
  rids: number[]
  capped: boolean
}

export function FindInFilesPanel({
  open,
  wsId,
  sources,
  onPivot,
  onClose
}: {
  open: boolean
  wsId: string | null
  /** All workspace sources — drives the group-scope dropdown. */
  sources: Array<{ sourceId: number; name: string; group?: string | null }>
  /** Jump to a file + focus exactly the matching rows (App's pivotToEvidence → a rowid filter). */
  onPivot: (sourceId: number, rids: number[]) => void
  onClose: () => void
}): JSX.Element | null {
  const [term, setTerm] = useState('')
  const [scope, setScope] = useState<string>(ALL)
  const [hits, setHits] = useState<Hit[] | null>(null) // null = no search run yet
  const [loading, setLoading] = useState(false)
  const [width, setWidth] = useState(DEFAULT_W)
  const inputRef = useRef<HTMLInputElement>(null)

  // The groups present, for the scope dropdown.
  const groups = useMemo(() => {
    const set = new Set<string>()
    let hasUngrouped = false
    for (const s of sources) {
      if (s.group) set.add(s.group)
      else hasUngrouped = true
    }
    return { named: [...set].sort((a, b) => a.localeCompare(b)), hasUngrouped }
  }, [sources])

  // Focus the box when the panel opens; clear stale results when the workspace changes.
  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])
  useEffect(() => {
    setHits(null)
    setTerm('')
    setScope(ALL)
  }, [wsId])

  async function run(): Promise<void> {
    const t = term.trim()
    if (!wsId || t === '') return
    setLoading(true)
    const group = scope === ALL ? undefined : scope === UNGROUPED ? null : scope
    try {
      const res = await window.api.csv.findInFiles(wsId, t, { group })
      setHits(res)
    } catch {
      setHits([])
    } finally {
      setLoading(false)
    }
  }

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

  if (!open) return null

  const fileCount = hits?.length ?? 0
  const totalMatches = hits?.reduce((n, h) => n + h.matchCount, 0) ?? 0

  return (
    <aside
      className="csv-find-in-files relative flex flex-col shrink-0 border-l border-citrus-border bg-citrus-cream dark:border-citrus-night-border dark:bg-citrus-night"
      style={{ width }}
    >
      <div
        onMouseDown={startResize}
        className="absolute top-0 left-0 z-30 -ml-1.5 h-full w-3 cursor-col-resize hover:bg-citrus-pink/40"
        title="Drag to resize"
      />

      <div className="flex items-center gap-2 border-b border-citrus-border px-3 py-2 dark:border-citrus-night-border">
        <Search className="h-4 w-4 shrink-0 text-citrus-pink" />
        <div className="min-w-0">
          <div className="text-xs font-bold text-citrus-dark dark:text-citrus-night-text">Find in files</div>
          <div className="font-mono text-[10px] text-citrus-muted dark:text-citrus-night-muted">
            {hits == null ? 'search every file for a string' : `${fileCount.toLocaleString()} files · ${totalMatches.toLocaleString()} rows`}
          </div>
        </div>
        <button onClick={onClose} className="ml-auto text-citrus-muted hover:text-citrus-pink" title="Close">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex flex-col gap-1.5 border-b border-citrus-border px-3 py-2 dark:border-citrus-night-border">
        <input
          ref={inputRef}
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void run()
          }}
          placeholder="find across files…"
          className="rounded border border-citrus-border bg-citrus-cream px-2 py-1 text-[12px] text-citrus-dark outline-none focus:border-citrus-pink dark:border-citrus-night-border dark:bg-citrus-night dark:text-citrus-night-text"
        />
        <div className="flex items-center gap-1.5">
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            title="Limit to a group, or search all"
            className="min-w-0 flex-1 rounded border border-citrus-border bg-citrus-cream px-1.5 py-1 text-[11px] text-citrus-dark outline-none focus:border-citrus-pink dark:border-citrus-night-border dark:bg-citrus-night dark:text-citrus-night-text"
          >
            <option value={ALL}>All sources</option>
            {groups.named.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
            {groups.hasUngrouped && <option value={UNGROUPED}>Ungrouped</option>}
          </select>
          <button
            onClick={() => void run()}
            disabled={!term.trim() || loading}
            className="inline-flex shrink-0 items-center gap-1 rounded bg-citrus-pink px-2.5 py-1 text-[11px] font-bold text-white hover:bg-citrus-pink-hover disabled:opacity-40"
          >
            {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Search className="h-3 w-3" />} Find
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto scrollbar-none">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-[11px] text-citrus-muted dark:text-citrus-night-muted">
            <Loader2 className="h-4 w-4 animate-spin text-citrus-pink" /> searching…
          </div>
        ) : hits == null ? (
          <div className="px-3 py-8 text-center text-[11px] text-citrus-muted dark:text-citrus-night-muted">
            Type a string and press Find.
          </div>
        ) : hits.length === 0 ? (
          <div className="px-3 py-8 text-center text-[11px] text-citrus-muted dark:text-citrus-night-muted">
            No file contains “{term.trim()}”{scope !== ALL ? ' in this group' : ''}.
          </div>
        ) : (
          <>
            <div className="px-3 py-1.5 text-[10px] text-citrus-muted dark:text-citrus-night-muted">click a file to jump to its rows</div>
            {hits.map((h) => (
              <button
                key={h.sourceId}
                onClick={() => onPivot(h.sourceId, h.rids)}
                className="group flex w-full items-center gap-2 border-b border-citrus-border/40 px-3 py-1.5 text-left text-[11px] hover:bg-citrus-pink-light/40 dark:border-citrus-night-border/40 dark:hover:bg-citrus-night-elev/50"
                title={`Jump to ${h.capped ? `the first ${h.rids.length.toLocaleString()} of ${h.matchCount.toLocaleString()}` : h.matchCount.toLocaleString()} matching row${h.matchCount === 1 ? '' : 's'} in ${h.name}`}
              >
                <FileText className="h-3.5 w-3.5 shrink-0 text-citrus-muted group-hover:text-citrus-pink dark:text-citrus-night-muted" />
                <span className="min-w-0 flex-1 truncate">
                  <span className="text-citrus-dark dark:text-citrus-night-text">{h.name}</span>
                  {h.group && <span className="ml-1.5 text-[10px] text-citrus-muted dark:text-citrus-night-muted">· {h.group}</span>}
                </span>
                <span className="shrink-0 font-mono text-citrus-muted group-hover:text-citrus-pink dark:text-citrus-night-muted">
                  {h.capped ? `${h.matchCount.toLocaleString()}` : h.matchCount.toLocaleString()}
                </span>
              </button>
            ))}
          </>
        )}
      </div>
    </aside>
  )
}
