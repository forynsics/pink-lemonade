import { getById } from '../tools/registry'
import type { ToolOptions } from '../tools/types'

/** Minimal shape needed to execute a step. */
export interface RunStep {
  toolId: string
  options: ToolOptions
  /** When false, the step is bypassed (output passes through unchanged). Defaults to enabled. */
  enabled?: boolean
}

/** A step as held in UI state (adds a stable key for React + reordering). */
export interface WorkflowStep extends RunStep {
  uid: string
}

export interface StepResult {
  toolId: string
  output: string
  error?: string
}

export interface WorkflowResult {
  /** Output of the last successful step (or the input if there are no steps). */
  output: string
  steps: StepResult[]
  /** Set if a step threw or referenced an unknown tool; the chain stops there. */
  error?: string
}

/**
 * Run input through each step in order, feeding each step's output into the next.
 * Never throws: a failing step is captured as an error and stops the chain, so the
 * UI can show which step broke and why.
 */
export function runWorkflow(input: string, steps: RunStep[]): WorkflowResult {
  let current = input
  const results: StepResult[] = []

  for (const step of steps) {
    // A bypassed step passes the current value through, keeping result indices aligned
    // with the UI step list (so error/output mapping by index stays correct).
    if (step.enabled === false) {
      results.push({ toolId: step.toolId, output: current })
      continue
    }
    const tool = getById(step.toolId)
    if (!tool) {
      const error = `Unknown tool: ${step.toolId}`
      results.push({ toolId: step.toolId, output: '', error })
      return { output: current, steps: results, error }
    }
    try {
      current = tool.run(current, step.options)
      results.push({ toolId: step.toolId, output: current })
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      results.push({ toolId: step.toolId, output: '', error })
      return { output: current, steps: results, error }
    }
  }

  return { output: current, steps: results }
}
