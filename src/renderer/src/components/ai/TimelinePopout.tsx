import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Clock, Download, RefreshCw, TableProperties } from 'lucide-react'
import type { CsvEvent } from '../../state/csvTypes'
import { buildTimelineRows, timelineToCsv, timelineToTable } from '../../state/timeline'
import { Timeline } from './Timeline'

// Full-window host for the Timeline (curated Plaso/l2t_csv super-timeline), mounted in a detached
// pop-out window. Same <Timeline> as the side panel, just with the whole window. Self-contained: it
// reads its workspace + source groups from the URL hash, loads/refreshes events over csv IPC, exports
// CSV directly, and relays pivot / build-as-grid-source back to the main window (which owns the grid).

export interface TimelinePopoutPayload {
  wsId: string
  /** Source id → group label (the Host column). */
  sources: Array<{ sourceId: number; group?: string | null }>
  title?: string
}

export function TimelinePopout({ payload }: { payload: TimelinePopoutPayload }): JSX.Element {
  const { wsId, sources, title } = payload
  const [events, setEvents] = useState<CsvEvent[]>([])
  const lastJson = useRef('')

  const reload = useCallback(async (): Promise<void> => {
    if (!wsId) {
      setEvents([])
      return
    }
    try {
      const next = await window.api.csv.wsEventList(wsId)
      const json = JSON.stringify(next)
      if (json !== lastJson.current) {
        lastJson.current = json
        setEvents(next)
      }
    } catch {
      // Workspace may have been closed in the main window — keep the last-loaded rows shown.
    }
  }, [wsId])

  useEffect(() => {
    void reload()
    const onFocus = (): void => void reload()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [reload])

  useEffect(() => {
    document.title = title ? `Timeline — ${title}` : 'Timeline'
  }, [title])

  const rows = useMemo(() => {
    const groupById = new Map(sources.map((s) => [s.sourceId, s.group ?? null]))
    return buildTimelineRows(events, (id) => groupById.get(id) ?? null)
  }, [events, sources])

  const pivot = (sourceId: number, rids: number[]): void => window.api.popout.relay({ type: 'pivot', wsId, sourceId, rids })

  async function exportCsv(): Promise<void> {
    if (rows.length === 0) return
    await window.api.saveFile(timelineToCsv(rows), 'pink-lemonade-timeline.csv')
  }

  const dated = rows.filter((r) => r.epoch != null).length

  return (
    <div className="flex h-full min-h-0 flex-col bg-citrus-bg dark:bg-citrus-night-bg">
      <div className="flex items-center justify-between gap-2 border-b border-citrus-border px-4 py-2.5 dark:border-citrus-night-border">
        <div className="flex items-center gap-2 min-w-0">
          <Clock className="w-4 h-4 text-citrus-pink shrink-0" />
          <div className="min-w-0">
            <div className="text-sm font-bold text-citrus-dark dark:text-citrus-night-text">
              Timeline{title ? <span className="text-citrus-muted dark:text-citrus-night-muted"> — {title}</span> : ''}
            </div>
            <div className="text-[11px] text-citrus-muted dark:text-citrus-night-muted">
              {rows.length} entr{rows.length === 1 ? 'y' : 'ies'}
              {rows.length > dated ? ` · ${rows.length - dated} undated` : ''}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button onClick={() => void reload()} title="Refresh" className="rounded p-1 text-citrus-muted hover:text-citrus-pink dark:text-citrus-night-muted">
            <RefreshCw className="w-4 h-4" />
          </button>
          {rows.length > 0 && (
            <button
              onClick={() => {
                const t = timelineToTable(rows, true)
                window.api.popout.relay({ type: 'buildTimeline', wsId, header: t.header, rows: t.rows })
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
        </div>
      </div>

      <div className="flex-1 min-h-0">
        <Timeline rows={rows} onPivot={pivot} />
      </div>
    </div>
  )
}
