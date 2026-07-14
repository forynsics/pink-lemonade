import { useEffect } from 'react'
import { AiPanel } from './AiPanel'
import type { AiWsCtx } from '../../state/enrichTypes'

// Full-window host for the AI assistant chat, mounted in a detached pop-out window. It reuses the
// SAME <AiPanel> (layout="window" so it fills the window) — the agent run streams to whichever window
// invoked it, so the chat is fully functional here. The workspace context is a SNAPSHOT taken when
// popped out (the popout isn't bound to the main window's active tab); grid actions the assistant
// proposes (pivot, group apply) and post-run refreshes are relayed back to the main window.

export interface AiPopoutPayload {
  /** The active-workspace context captured at pop-out time. */
  wsCtx: AiWsCtx
  title?: string
}

export function AiPopout({ payload }: { payload: AiPopoutPayload }): JSX.Element {
  const { wsCtx, title } = payload
  const wsId = wsCtx.wsId

  // Match the ConstellationPopout/TimelinePopout window-title convention ("<Feature> — <workspace>").
  useEffect(() => {
    document.title = title ? `AI Assistant — ${title}` : 'AI Assistant'
  }, [title])
  const refresh = (what: 'findings' | 'tags' | 'iocs' | 'investigation'): void => {
    if (wsId) window.api.popout.relay({ type: 'refresh', wsId, what })
  }

  return (
    <AiPanel
      open
      layout="window"
      onClose={() => window.close()}
      getWsCtx={() => wsCtx}
      scopeId={wsCtx.wsId ?? null}
      onTagsChanged={() => refresh('tags')}
      onFindingsChanged={() => refresh('findings')}
      onIocsChanged={() => refresh('iocs')}
      onInvestigationChanged={() => refresh('investigation')}
      onApplyGroup={(sourceId, group) => {
        if (wsId) window.api.popout.relay({ type: 'applyGroup', wsId, sourceId, group })
      }}
      onPivot={(value, source) => {
        if (wsId) window.api.popout.relay({ type: 'pivotValue', wsId, value, source })
      }}
    />
  )
}
