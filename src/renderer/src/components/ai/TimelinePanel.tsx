import { useCallback, useEffect, useMemo, useState } from 'react'
import { Clock, Download, ExternalLink, Maximize2, Minimize2, TableProperties, X } from 'lucide-react'
import type { CsvEvent } from '../../state/csvTypes'
import { buildTimelineRows, timelineToCsv, timelineToTable } from '../../state/timeline'
import { Timeline } from './Timeline'

// Side-panel host for the Timeline — the curated, deterministic Plaso/l2t_csv-style super-timeline
// built from recorded events. Thin shell: loads the workspace's events, resolves each evidence's Host
// from the source groups, composes the rows, and mounts <Timeline>. Export writes l2t_csv-style CSV.

const MIN_W = 420
const MAX_W = 1100

export function TimelinePanel({
  open,
  onClose,
  wsId,
  workspaceName,
  refreshKey,
  sources,
  onPivot,
  onBuildSource
}: {
  open: boolean
  onClose: () => void
  /** The active workspace, or null when no workspace is on screen. */
  wsId: string | null
  /** Active workspace name — the pop-out window's subtitle. */
  workspaceName?: string | null
  /** Bump to reload events (e.g. after the assistant records one). */
  refreshKey: number
  /** Source id → group label (the Host column). */
  sources: Array<{ sourceId: number; group?: string | null }>
  onPivot: (sourceId: number, rids: number[]) => void
  /** Materialize the current rows as a real workspace source (opens it in the grid). */
  onBuildSource: (header: string[], rows: string[][]) => void
}): JSX.Element | null {
  const [events, setEvents] = useState<CsvEvent[]>([])
  const [width, setWidth] = useState(640)
  const [maximized, setMaximized] = useState(false)

  const reload = useCallback(async (): Promise<void> => {
    if (!wsId) {
      setEvents([])
      return
    }
    setEvents(await window.api.csv.wsEventList(wsId))
  }, [wsId])

  useEffect(() => {
    if (open) void reload()
  }, [open, reload, refreshKey])

  const rows = useMemo(() => {
    const groupById = new Map(sources.map((s) => [s.sourceId, s.group ?? null]))
    return buildTimelineRows(events, (id) => groupById.get(id) ?? null)
  }, [events, sources])

  const startResize = (e: React.MouseEvent): void => {
    if (maximized) return
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    const onMove = (ev: MouseEvent): void => setWidth(Math.min(MAX_W, Math.max(MIN_W, startW + (startX - ev.clientX))))
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  async function exportCsv(): Promise<void> {
    if (rows.length === 0) return
    await window.api.saveFile(timelineToCsv(rows), 'pink-lemonade-timeline.csv')
  }

  function popOut(): void {
    if (!wsId) return
    void window.api.popout.open('timeline', {
      wsId,
      title: workspaceName ?? undefined,
      sources: sources.map((s) => ({ sourceId: s.sourceId, group: s.group ?? null }))
    })
  }

  if (!open) return null

  const dated = rows.filter((r) => r.epoch != null).length

  return (
    <aside
      className="timeline-panel relative flex min-h-0 shrink-0 flex-col border-l border-citrus-border bg-citrus-card dark:border-citrus-night-border dark:bg-citrus-night-card"
      style={{ width: maximized ? 'min(1200px, 82vw)' : width }}
    >
      {!maximized && <div className="absolute left-0 top-0 z-10 h-full w-1 cursor-col-resize hover:bg-citrus-pink/40" onMouseDown={startResize} title="Drag to resize" />}

      <div className="flex items-center justify-between gap-2 border-b border-citrus-border px-4 py-3 dark:border-citrus-night-border">
        <div className="flex items-center gap-2 min-w-0">
          <Clock className="w-4 h-4 text-citrus-pink shrink-0" />
          <div className="min-w-0">
            <div className="text-sm font-bold text-citrus-dark dark:text-citrus-night-text">Timeline</div>
            <div className="text-[11px] text-citrus-muted dark:text-citrus-night-muted">
              {rows.length} entr{rows.length === 1 ? 'y' : 'ies'}
              {rows.length > dated ? ` · ${rows.length - dated} undated` : ''}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {rows.length > 0 && (
            <button
              onClick={() => {
                const t = timelineToTable(rows, true)
                onBuildSource(t.header, t.rows)
              }}
              title="Open as a grid source"
              className="rounded p-1 text-citrus-muted hover:text-citrus-pink dark:text-citrus-night-muted"
            >
              <TableProperties className="w-4 h-4" />
            </button>
          )}
          {rows.length > 0 && (
            <button onClick={() => void exportCsv()} title="Export as CSV (l2t_csv columns)" className="rounded p-1 text-citrus-muted hover:text-citrus-pink dark:text-citrus-night-muted">
              <Download className="w-4 h-4" />
            </button>
          )}
          {wsId && (
            <button onClick={popOut} title="Pop out" className="rounded p-1 text-citrus-muted hover:text-citrus-pink dark:text-citrus-night-muted">
              <ExternalLink className="w-4 h-4" />
            </button>
          )}
          <button onClick={() => setMaximized((m) => !m)} title={maximized ? 'Restore' : 'Maximize'} className="rounded p-1 text-citrus-muted hover:text-citrus-pink dark:text-citrus-night-muted">
            {maximized ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>
          <button onClick={onClose} title="Close" className="rounded p-1 text-citrus-muted hover:text-citrus-pink dark:text-citrus-night-muted">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0">
        <Timeline rows={rows} onPivot={onPivot} />
      </div>
    </aside>
  )
}
