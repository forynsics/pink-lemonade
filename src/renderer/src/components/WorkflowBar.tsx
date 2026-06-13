import { getById } from '../tools/registry'
import { ToolOptions } from './ToolOptions'
import type { WorkflowResult, WorkflowStep } from '../state/workflow'
import type { ToolOptions as Opts } from '../tools/types'

export function WorkflowBar({
  steps,
  result,
  onRemove,
  onMove,
  onOptions,
  onClear
}: {
  steps: WorkflowStep[]
  result: WorkflowResult
  onRemove: (uid: string) => void
  onMove: (uid: string, dir: -1 | 1) => void
  onOptions: (uid: string, o: Opts) => void
  onClear: () => void
}): JSX.Element {
  if (steps.length === 0) {
    return (
      <div className="workflow workflow--empty">
        Pick a tool on the left to build a workflow. Steps run top → bottom; each one feeds
        the next.
      </div>
    )
  }

  return (
    <div className="workflow">
      <div className="workflow__head">
        <span className="workflow__title">Workflow · {steps.length} step{steps.length > 1 ? 's' : ''}</span>
        <button className="btn btn--ghost" onClick={onClear}>
          Clear
        </button>
      </div>
      <div className="workflow__steps">
        {steps.map((s, i) => {
          const tool = getById(s.toolId)
          const stepResult = result.steps[i]
          const failed = !!stepResult?.error
          return (
            <div key={s.uid} className={`step${failed ? ' step--error' : ''}`}>
              <div className="step__head">
                <span className="step__index">{i + 1}</span>
                <span className="step__name">{tool?.name ?? s.toolId}</span>
                <div className="step__actions">
                  <button
                    className="btn btn--icon"
                    disabled={i === 0}
                    onClick={() => onMove(s.uid, -1)}
                    title="Move up"
                  >
                    ↑
                  </button>
                  <button
                    className="btn btn--icon"
                    disabled={i === steps.length - 1}
                    onClick={() => onMove(s.uid, 1)}
                    title="Move down"
                  >
                    ↓
                  </button>
                  <button className="btn btn--icon" onClick={() => onRemove(s.uid)} title="Remove">
                    ✕
                  </button>
                </div>
              </div>
              <ToolOptions toolId={s.toolId} options={s.options} onChange={(o) => onOptions(s.uid, o)} />
              {failed && <div className="step__error">{stepResult?.error}</div>}
            </div>
          )
        })}
      </div>
    </div>
  )
}
