import { useMemo, useState } from 'react'
import { Crosshair, X } from 'lucide-react'

// Target picker for the Intel-tab → sweep pivot: choose which open workspace + source to sweep the
// selected indicators into. Shown only when more than one source is open (App auto-targets a lone one).

export interface SweepTargetWorkspace {
  id: string
  name: string
  sources: Array<{ sourceId: number; name: string }>
}

export function IntelSweepTargetDialog({
  workspaces,
  indicatorCount,
  onConfirm,
  onCancel
}: {
  workspaces: SweepTargetWorkspace[]
  indicatorCount: number
  onConfirm: (wsDocId: string, sourceId: number) => void
  onCancel: () => void
}): JSX.Element {
  const [wsId, setWsId] = useState(workspaces[0]?.id ?? '')
  const ws = useMemo(() => workspaces.find((w) => w.id === wsId) ?? workspaces[0], [workspaces, wsId])
  const [sourceId, setSourceId] = useState<number>(ws?.sources[0]?.sourceId ?? -1)

  // Keep the source selection valid when the workspace changes.
  function pickWorkspace(id: string): void {
    setWsId(id)
    const next = workspaces.find((w) => w.id === id)
    setSourceId(next?.sources[0]?.sourceId ?? -1)
  }

  const canRun = !!ws && sourceId >= 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onCancel}>
      <div
        className="w-[26rem] max-w-[92vw] rounded-xl border border-citrus-border bg-citrus-card shadow-lg dark:border-citrus-night-border dark:bg-citrus-night-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-citrus-border px-5 py-3 dark:border-citrus-night-border">
          <Crosshair className="h-4 w-4 text-red-500 dark:text-red-400" />
          <span className="text-sm font-bold text-citrus-dark dark:text-citrus-night-text">Run Intel Sweep</span>
          <span className="text-xs text-citrus-muted dark:text-citrus-night-muted">
            · {indicatorCount.toLocaleString()} {indicatorCount === 1 ? 'indicator' : 'indicators'}
          </span>
          <button onClick={onCancel} className="ml-auto text-citrus-muted hover:text-citrus-pink dark:text-citrus-night-muted">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-4">
          <p className="mb-3 text-xs text-citrus-muted dark:text-citrus-night-muted">
            Choose which source to sweep these indicators into. The Sweep dialog opens pre-filled so you can pick
            columns and how to merge.
          </p>

          <label className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-citrus-muted dark:text-citrus-night-muted">
            Workspace
          </label>
          <select
            value={wsId}
            onChange={(e) => pickWorkspace(e.target.value)}
            className="mb-3 w-full rounded-md border border-citrus-border bg-citrus-cream px-2 py-1.5 text-xs text-citrus-dark outline-none focus:border-citrus-pink dark:border-citrus-night-border dark:bg-citrus-night dark:text-citrus-night-text"
          >
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>

          <label className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-citrus-muted dark:text-citrus-night-muted">
            Source
          </label>
          <select
            value={sourceId}
            onChange={(e) => setSourceId(Number(e.target.value))}
            className="w-full rounded-md border border-citrus-border bg-citrus-cream px-2 py-1.5 text-xs text-citrus-dark outline-none focus:border-citrus-pink dark:border-citrus-night-border dark:bg-citrus-night dark:text-citrus-night-text"
          >
            {(ws?.sources ?? []).map((s) => (
              <option key={s.sourceId} value={s.sourceId}>
                {s.name}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-citrus-border px-5 py-3 dark:border-citrus-night-border">
          <button
            onClick={onCancel}
            className="rounded-md border border-citrus-border px-3 py-1 text-[11px] font-bold text-citrus-muted hover:text-citrus-pink hover:border-citrus-pink/40 dark:border-citrus-night-border dark:text-citrus-night-muted"
          >
            Cancel
          </button>
          <button
            onClick={() => ws && canRun && onConfirm(ws.id, sourceId)}
            disabled={!canRun}
            className="inline-flex items-center gap-1 rounded-md bg-red-500 px-3 py-1 text-[11px] font-bold text-white hover:bg-red-600 disabled:opacity-40"
          >
            <Crosshair className="h-3.5 w-3.5" /> Next
          </button>
        </div>
      </div>
    </div>
  )
}
