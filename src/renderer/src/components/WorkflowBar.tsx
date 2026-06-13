import { AnimatePresence, motion } from 'motion/react'
import { ChevronUp, ChevronDown, Trash2, Info } from 'lucide-react'
import { getById } from '../tools/registry'
import { ToolOptions } from './ToolOptions'
import { toolIcon } from './toolIcons'
import type { WorkflowResult, WorkflowStep } from '../state/workflow'
import type { ToolOptions as Opts } from '../tools/types'

export function WorkflowBar({
  steps,
  result,
  onRemove,
  onMove,
  onOptions,
  onToggleEnabled,
  onClear
}: {
  steps: WorkflowStep[]
  result: WorkflowResult
  onRemove: (uid: string) => void
  onMove: (uid: string, dir: -1 | 1) => void
  onOptions: (uid: string, o: Opts) => void
  onToggleEnabled: (uid: string) => void
  onClear: () => void
}): JSX.Element {
  if (steps.length === 0) {
    return (
      <div className="flex items-center gap-2 px-4 py-3 text-xs text-citrus-muted border-b border-citrus-border bg-citrus-yellow-light/40 dark:text-citrus-night-muted dark:border-citrus-night-border dark:bg-citrus-night">
        <Info className="w-3.5 h-3.5 text-citrus-yellow" />
        <span>Pick a tool on the left to build a workflow. Steps run top → bottom; each one feeds the next.</span>
      </div>
    )
  }

  return (
    <div className="flex flex-col min-h-0 max-h-[42%] border-b border-citrus-border bg-citrus-cream/60 dark:border-citrus-night-border dark:bg-citrus-night">
      <div className="flex items-center justify-between px-4 py-2">
        <span className="text-xs font-bold text-citrus-dark dark:text-citrus-night-text">
          Workflow · {steps.length} step{steps.length > 1 ? 's' : ''}
        </span>
        <button
          className="text-[11px] font-bold text-citrus-muted hover:text-citrus-pink transition-colors dark:text-citrus-night-muted"
          onClick={onClear}
        >
          Clear
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-2">
        <AnimatePresence initial={false} mode="popLayout">
          {steps.map((s, i) => {
            const tool = getById(s.toolId)
            const stepResult = result.steps[i]
            const failed = !!stepResult?.error
            const disabled = s.enabled === false
            const Icon = toolIcon(s.toolId, tool?.category ?? 'text')
            return (
              <motion.div
                key={s.uid}
                layout
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.97 }}
                transition={{ duration: 0.15 }}
                className={`step rounded-xl border p-2.5 shadow-sm transition-colors ${
                  failed
                    ? 'border-citrus-pink/60 bg-citrus-pink-light/50 dark:bg-citrus-pink/10'
                    : 'border-citrus-border bg-citrus-card dark:border-citrus-night-border dark:bg-citrus-night-card'
                } ${disabled ? 'opacity-55' : ''}`}
              >
                <div className="flex items-center gap-2">
                  <span className="grid place-items-center w-6 h-6 rounded-full bg-citrus-pink/15 text-citrus-pink text-[11px] font-bold">
                    {i + 1}
                  </span>
                  <Icon className="w-4 h-4 text-citrus-pink shrink-0" />
                  <span
                    className={`text-xs font-semibold truncate flex-1 text-citrus-dark dark:text-citrus-night-text ${
                      disabled ? 'line-through' : ''
                    }`}
                  >
                    {tool?.name ?? s.toolId}
                  </span>
                  <div className="flex items-center gap-0.5">
                    <button
                      className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase transition-colors ${
                        disabled
                          ? 'text-citrus-muted hover:text-citrus-dark dark:text-citrus-night-muted'
                          : 'text-emerald-600 dark:text-emerald-400'
                      }`}
                      onClick={() => onToggleEnabled(s.uid)}
                      title={disabled ? 'Enable step' : 'Bypass step'}
                    >
                      {disabled ? 'off' : 'on'}
                    </button>
                    <button
                      className="p-1 rounded text-citrus-muted hover:text-citrus-dark disabled:opacity-30 dark:text-citrus-night-muted"
                      disabled={i === 0}
                      onClick={() => onMove(s.uid, -1)}
                      title="Move up"
                    >
                      <ChevronUp className="w-3.5 h-3.5" />
                    </button>
                    <button
                      className="p-1 rounded text-citrus-muted hover:text-citrus-dark disabled:opacity-30 dark:text-citrus-night-muted"
                      disabled={i === steps.length - 1}
                      onClick={() => onMove(s.uid, 1)}
                      title="Move down"
                    >
                      <ChevronDown className="w-3.5 h-3.5" />
                    </button>
                    <button
                      className="p-1 rounded text-citrus-muted hover:text-citrus-pink"
                      onClick={() => onRemove(s.uid)}
                      title="Remove"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
                {!disabled && (
                  <ToolOptions toolId={s.toolId} options={s.options} onChange={(o) => onOptions(s.uid, o)} />
                )}
                {failed && (
                  <div className="mt-2 text-[11px] text-citrus-pink-hover font-medium">{stepResult?.error}</div>
                )}
              </motion.div>
            )
          })}
        </AnimatePresence>
      </div>
    </div>
  )
}
