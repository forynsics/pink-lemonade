import { useCallback, useEffect, useRef, useState } from 'react'
import { Network, RefreshCw, Trash2 } from 'lucide-react'
import type { CsvEvent, CsvIoc } from '../../state/csvTypes'
import { Constellation } from './Constellation'

// Full-window host for the Artifact Constellation, mounted in a detached pop-out window (see
// createPopoutWindow in main). It renders the SAME <Constellation> as the side panel, just with the
// whole window to breathe — the side panel was too cramped. Self-contained: it reads its workspace +
// source groups from the window's URL hash and loads/refreshes events over the existing csv IPC.
// Pivots (jump-to-evidence) are forwarded to the main window's grid via window.api.popout.pivot.

export interface ConstellationPopoutPayload {
  wsId: string
  /** Source id → group label, for clustering the constellation by host/system. */
  sources: Array<{ sourceId: number; group?: string | null }>
  /** Window subtitle (the workspace name). */
  title?: string
}

export function ConstellationPopout({ payload }: { payload: ConstellationPopoutPayload }): JSX.Element {
  const { wsId, sources, title } = payload
  const [events, setEvents] = useState<CsvEvent[]>([])
  const [iocs, setIocs] = useState<CsvIoc[]>([])
  const [iocLinks, setIocLinks] = useState<Array<{ iocId: string; eventIds: string[] }>>([])
  const [confirmClear, setConfirmClear] = useState(false)
  const lastJson = useRef('')

  // Reload, but only re-render when the data actually changed — the graph re-layouts on a new events
  // array, so swapping in an equal one would needlessly reset pan/zoom.
  const reload = useCallback(async (): Promise<void> => {
    if (!wsId) {
      setEvents([])
      setIocs([])
      setIocLinks([])
      return
    }
    try {
      const [nextEvents, nextIocs, nextLinks] = await Promise.all([
        window.api.csv.wsEventList(wsId),
        window.api.csv.wsIocList(wsId),
        window.api.csv.wsIocEventLinks(wsId)
      ])
      const json = JSON.stringify({ e: nextEvents, i: nextIocs, l: nextLinks })
      if (json !== lastJson.current) {
        lastJson.current = json
        setEvents(nextEvents)
        setIocs(nextIocs)
        setIocLinks(nextLinks)
      }
    } catch {
      // The workspace may have been closed in the main window — leave the last-loaded data shown.
    }
  }, [wsId])

  // Load on mount and whenever this window regains focus (events recorded in the main window since).
  useEffect(() => {
    void reload()
    const onFocus = (): void => void reload()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [reload])

  useEffect(() => {
    document.title = title ? `Artifact Constellation — ${title}` : 'Artifact Constellation'
  }, [title])

  const pivot = (sourceId: number, rids: number[]): void => window.api.popout.relay({ type: 'pivot', wsId, sourceId, rids })

  async function deleteEvent(id: string): Promise<void> {
    await window.api.csv.wsEventDelete(wsId, id)
    await reload()
    window.api.popout.relay({ type: 'refresh', wsId, what: 'events' }) // else the main window keeps the deleted node
  }
  async function clearAll(): Promise<void> {
    await window.api.csv.wsEventClear(wsId)
    setConfirmClear(false)
    await reload()
    window.api.popout.relay({ type: 'refresh', wsId, what: 'events' })
  }
  async function updateEvent(id: string, fields: { label: string; description: string | null; technique: string | null; users: string[] }): Promise<void> {
    await window.api.csv.wsEventUpdate(wsId, id, fields)
    await reload()
    window.api.popout.relay({ type: 'refresh', wsId, what: 'events' }) // keep the main window's panels in sync
  }
  async function removeEvidence(evidenceId: number): Promise<void> {
    await window.api.csv.wsEvidenceDelete(wsId, evidenceId)
    await reload()
    window.api.popout.relay({ type: 'refresh', wsId, what: 'events' })
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-citrus-bg dark:bg-citrus-night-bg">
      <div className="flex items-center justify-between gap-2 border-b border-citrus-border px-4 py-2.5 dark:border-citrus-night-border">
        <div className="flex items-center gap-2 min-w-0">
          <Network className="w-4 h-4 text-citrus-pink shrink-0" />
          <div className="min-w-0">
            <div className="text-sm font-bold text-citrus-dark dark:text-citrus-night-text">
              Artifact Constellation{title ? <span className="text-citrus-muted dark:text-citrus-night-muted"> — {title}</span> : ''}
            </div>
            <div className="text-[11px] text-citrus-muted dark:text-citrus-night-muted">
              {events.length} event{events.length === 1 ? '' : 's'} — click one to see its corroborating evidence and jump to those rows in the main window.
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button onClick={() => void reload()} title="Refresh" className="rounded p-1 text-citrus-muted hover:text-citrus-pink dark:text-citrus-night-muted">
            <RefreshCw className="w-4 h-4" />
          </button>
          {events.length > 0 &&
            (confirmClear ? (
              <button
                onClick={() => void clearAll()}
                title="Confirm — remove every event from the constellation"
                className="rounded border border-red-500/60 bg-red-500/10 px-1.5 py-0.5 text-[11px] font-semibold text-red-600 dark:border-red-400/60 dark:text-red-400"
              >
                Clear all?
              </button>
            ) : (
              <button onClick={() => setConfirmClear(true)} title="Clear all events" className="rounded p-1 text-citrus-muted hover:text-red-600 dark:text-citrus-night-muted">
                <Trash2 className="w-4 h-4" />
              </button>
            ))}
        </div>
      </div>

      <div className="flex-1 min-h-0">
        <Constellation
          events={events}
          iocs={iocs}
          iocLinks={iocLinks}
          sources={sources}
          onPivot={pivot}
          onDelete={(id) => void deleteEvent(id)}
          onUpdate={(id, f) => void updateEvent(id, f)}
          onDeleteEvidence={(eid) => void removeEvidence(eid)}
        />
      </div>
    </div>
  )
}
