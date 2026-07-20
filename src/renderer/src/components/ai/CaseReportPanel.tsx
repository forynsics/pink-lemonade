import { ClipboardCheck, ExternalLink, X } from 'lucide-react'
import { CaseReportBody } from './CaseReportBody'
import type { CsvCaseReportItem } from '../../state/csvTypes'
import { usePanelWidth } from '../../state/panelWidth'

// The Case Report as a side panel. Adjudicating dozens of claims with reasons is cramped here, so the
// pop-out button opens the SAME body full-window (the existing popout:open machinery, as used by the
// Constellation and Timeline). Persisted, viewport-relative width like the other AI panels.

export function CaseReportPanel({
  open,
  onClose,
  wsId,
  workspaceName,
  refreshKey,
  onOpen
}: {
  open: boolean
  onClose: () => void
  wsId: string | null
  workspaceName: string | null
  refreshKey: number
  onOpen?: (item: CsvCaseReportItem) => void
}): JSX.Element | null {
  const { width, setWidth, clamp } = usePanelWidth({ key: 'pink-lemonade:panel-w:casereport', min: 340, max: 760, defaultFraction: 0.32 })

  const startResize = (e: React.MouseEvent): void => {
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    const onMove = (ev: MouseEvent): void => setWidth(clamp(startW + (startX - ev.clientX)))
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  function popOut(): void {
    if (!wsId) return
    void window.api.popout.open('casereport', { wsId, title: workspaceName ?? undefined })
  }

  if (!open) return null

  return (
    <aside
      className="casereport-panel relative flex min-h-0 shrink-0 flex-col border-l border-citrus-border bg-citrus-card dark:border-citrus-night-border dark:bg-citrus-night-card"
      style={{ width }}
    >
      <div className="absolute left-0 top-0 z-10 h-full w-1 cursor-col-resize hover:bg-citrus-pink/40" onMouseDown={startResize} title="Drag to resize" />

      <div className="flex items-center justify-between gap-2 border-b border-citrus-border px-4 py-3 dark:border-citrus-night-border">
        <div className="flex min-w-0 items-center gap-2">
          <ClipboardCheck className="h-4 w-4 shrink-0 text-citrus-pink" />
          <div className="min-w-0">
            <div className="text-sm font-bold text-citrus-dark dark:text-citrus-night-text">Case Report</div>
            <div className="text-[11px] text-citrus-muted dark:text-citrus-night-muted">Approve or reject the case&apos;s findings</div>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button onClick={popOut} title="Open in its own window" className="rounded p-1 text-citrus-muted hover:text-citrus-pink dark:text-citrus-night-muted">
            <ExternalLink className="h-4 w-4" />
          </button>
          <button onClick={onClose} title="Close" className="rounded p-1 text-citrus-muted hover:text-citrus-pink dark:text-citrus-night-muted">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <CaseReportBody wsId={wsId} refreshKey={refreshKey} onOpen={onOpen} />
    </aside>
  )
}
