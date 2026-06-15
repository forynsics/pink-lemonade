import { useDeferredValue, useMemo } from 'react'
import { WorkflowBar } from './WorkflowBar'
import { Workbench } from './Workbench'
import { runWorkflow } from '../state/workflow'
import type { ScratchDoc } from '../state/documents'
import type { ToolOptions } from '../tools/types'

// One scratch document's editor (workflow bar + input/output panes). App mounts ONE of these per
// scratch doc and toggles visibility, so each notepad keeps its own component state — caret,
// scroll position, and Ctrl+F find — instead of sharing a single reused instance. A hidden
// editor stays mounted (display:none), so switching tabs or to the CSV viewer never loses your
// place. The workflow result is memoized per doc, so hidden docs don't recompute.
export function ScratchEditor({
  doc,
  visible,
  onInput,
  onRemoveStep,
  onMoveStep,
  onUpdateOptions,
  onToggleStepEnabled,
  onClearSteps,
  onSendToEnrichment
}: {
  doc: ScratchDoc
  visible: boolean
  onInput: (v: string) => void
  onRemoveStep: (uid: string) => void
  onMoveStep: (uid: string, dir: -1 | 1) => void
  onUpdateOptions: (uid: string, options: ToolOptions) => void
  onToggleStepEnabled: (uid: string) => void
  onClearSteps: () => void
  onSendToEnrichment: (values: string[]) => void
}): JSX.Element {
  const deferredInput = useDeferredValue(doc.input)
  const result = useMemo(() => runWorkflow(deferredInput, doc.steps), [deferredInput, doc.steps])
  return (
    <div className="flex flex-col flex-1 min-h-0" style={{ display: visible ? 'flex' : 'none' }}>
      <WorkflowBar
        steps={doc.steps}
        result={result}
        onRemove={onRemoveStep}
        onMove={onMoveStep}
        onOptions={onUpdateOptions}
        onToggleEnabled={onToggleStepEnabled}
        onClear={onClearSteps}
      />
      <Workbench
        input={doc.input}
        onInput={onInput}
        result={result}
        active={visible}
        onSendToEnrichment={onSendToEnrichment}
      />
    </div>
  )
}
