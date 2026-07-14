import { useCallback, useEffect, useRef, useState } from 'react'
import { ExternalLink, Maximize2, Minimize2, Network, Trash2, X } from 'lucide-react'
import type { CsvEvent, CsvIoc } from '../../state/csvTypes'
import { Constellation } from './Constellation'

// The side-panel host for the constellation. Thin shell: loads the workspace's findings, handles
// resize/maximize and clear, and mounts the host-agnostic <Constellation>. The "pop out" button
// mounts the SAME <Constellation> in its own window (ConstellationPopout) — the graph code is shared.

const MIN_W = 360
const MAX_W = 900

export function ConstellationPanel({
  open,
  onClose,
  wsId,
  workspaceName,
  refreshKey,
  iocRefreshKey,
  sources,
  onPivot,
  onSendToIntel
}: {
  open: boolean
  onClose: () => void
  /** The active workspace, or null when no workspace is on screen. */
  wsId: string | null
  /** Active workspace name — the pop-out window's subtitle. */
  workspaceName?: string | null
  /** Bump to reload events (e.g. after the assistant records one). */
  refreshKey: number
  /** Bump to reload the IOC catalog (the "IOCs" view) after the assistant records one. */
  iocRefreshKey: number
  /** Source id → group label, for clustering the constellation's source column by host/system. */
  sources: Array<{ sourceId: number; group?: string | null }>
  onPivot: (sourceId: number, rids: number[]) => void
  /** Send an enrichable IOC's value to the Intel grid. */
  onSendToIntel?: (values: string[]) => void
}): JSX.Element | null {
  const [events, setEvents] = useState<CsvEvent[]>([])
  const [iocs, setIocs] = useState<CsvIoc[]>([])
  const [iocLinks, setIocLinks] = useState<Array<{ iocId: string; eventIds: string[] }>>([])
  const [width, setWidth] = useState(520)
  const [maximized, setMaximized] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)

  const reload = useCallback(async (): Promise<void> => {
    if (!wsId) {
      setEvents([])
      setIocs([])
      setIocLinks([])
      return
    }
    const [ev, ic, links] = await Promise.all([
      window.api.csv.wsEventList(wsId),
      window.api.csv.wsIocList(wsId),
      window.api.csv.wsIocEventLinks(wsId)
    ])
    setEvents(ev)
    setIocs(ic)
    setIocLinks(links)
  }, [wsId])

  useEffect(() => {
    if (open) void reload()
  }, [open, reload, refreshKey, iocRefreshKey])

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

  async function deleteEvent(id: string): Promise<void> {
    if (!wsId) return
    await window.api.csv.wsEventDelete(wsId, id)
    await reload()
  }
  async function updateEvent(id: string, fields: { label: string; description: string | null; technique: string | null; users: string[] }): Promise<void> {
    if (!wsId) return
    await window.api.csv.wsEventUpdate(wsId, id, fields)
    await reload()
  }
  async function removeEvidence(evidenceId: number): Promise<void> {
    if (!wsId) return
    await window.api.csv.wsEvidenceDelete(wsId, evidenceId)
    await reload()
  }
  async function clearAll(): Promise<void> {
    if (!wsId) return
    await window.api.csv.wsEventClear(wsId)
    setConfirmClear(false)
    await reload()
  }

  function popOut(): void {
    if (!wsId) return
    void window.api.popout.open('constellation', {
      wsId,
      title: workspaceName ?? undefined,
      sources: sources.map((s) => ({ sourceId: s.sourceId, group: s.group ?? null }))
    })
  }

  if (!open) return null

  return (
    <aside
      className="constellation-panel relative flex min-h-0 shrink-0 flex-col border-l border-citrus-border bg-citrus-card dark:border-citrus-night-border dark:bg-citrus-night-card"
      style={{ width: maximized ? 'min(1100px, 78vw)' : width }}
    >
      {!maximized && <div className="absolute left-0 top-0 z-10 h-full w-1 cursor-col-resize hover:bg-citrus-pink/40" onMouseDown={startResize} title="Drag to resize" />}

      <div className="flex items-center justify-between gap-2 border-b border-citrus-border px-4 py-3 dark:border-citrus-night-border">
        <div className="flex items-center gap-2 min-w-0">
          <Network className="w-4 h-4 text-citrus-pink shrink-0" />
          <div className="min-w-0">
            <div className="text-sm font-bold text-citrus-dark dark:text-citrus-night-text">Artifact Constellation</div>
            <div className="text-[11px] text-citrus-muted dark:text-citrus-night-muted">{events.length} event{events.length === 1 ? '' : 's'} — click one to see its corroborating evidence.</div>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
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
          {wsId && (
            <button onClick={popOut} title="Pop out into its own window" className="rounded p-1 text-citrus-muted hover:text-citrus-pink dark:text-citrus-night-muted">
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
        <Constellation
          events={events}
          iocs={iocs}
          iocLinks={iocLinks}
          sources={sources}
          onPivot={onPivot}
          onDelete={(id) => void deleteEvent(id)}
          onUpdate={(id, f) => void updateEvent(id, f)}
          onDeleteEvidence={(eid) => void removeEvidence(eid)}
          onSendToIntel={onSendToIntel}
        />
      </div>
    </aside>
  )
}
