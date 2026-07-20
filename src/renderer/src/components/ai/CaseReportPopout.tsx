import { useEffect, useState } from 'react'
import { CaseReportBody } from './CaseReportBody'
import type { CsvCaseReportItem } from '../../state/csvTypes'

// Full-window host for the Case Report, mounted in a detached pop-out. Same <CaseReportBody> as the
// side panel, given the whole window — adjudicating a case's worth of claims with reasons wants room.
// Reads its workspace from the URL hash and re-polls on focus (the agent writes from the main window).

export interface CaseReportPopoutPayload {
  wsId: string
  title?: string
}

export function CaseReportPopout({ payload }: { payload: CaseReportPopoutPayload }): JSX.Element {
  const { wsId, title } = payload
  const [tick, setTick] = useState(0)

  useEffect(() => {
    document.title = title ? `Case Report — ${title}` : 'Case Report'
  }, [title])

  // The agent (in the main window) records claims while this is open; refresh when the window regains
  // focus so the queue reflects what has landed since.
  useEffect(() => {
    const onFocus = (): void => setTick((t) => t + 1)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  return (
    <div className="flex h-screen flex-col bg-citrus-bg text-citrus-dark dark:bg-citrus-night-bg dark:text-citrus-night-text">
      <div className="flex items-center gap-2 border-b border-citrus-border px-4 py-2.5 dark:border-citrus-night-border">
        <div className="text-sm font-bold">Case Report</div>
        <div className="text-[11px] text-citrus-muted dark:text-citrus-night-muted">{title ?? ''}</div>
      </div>
      <CaseReportBody
        wsId={wsId}
        refreshKey={tick}
        onOpen={(item: CsvCaseReportItem): void => window.api.popout.relay({ type: 'openClaim', wsId, kind: item.kind, id: item.id })}
      />
    </div>
  )
}
