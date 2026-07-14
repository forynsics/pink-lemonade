// Cross-session continuity for the agent. Coverage (which sources were examined) and the investigation
// plan/notes live in the workspace DB, so an investigation survives a timeout / Continue / restart. At
// the start of a run we SEED the in-memory coverage tracker from disk and build a "resume from here"
// block (plan + notes + a findings/coverage roll-up) injected into the system prompt; at the end we
// PERSIST whatever new sources got examined. The agent then continues instead of re-walking the case.

import * as dbw from '../csv/dbClient'
import { coverageUniverse } from './coverage'
import type { CoverageTracker, WsCtx } from './types'

export type PlanStatus = 'pending' | 'active' | 'done'
export interface PlanStep {
  text: string
  status: PlanStatus
}

/** Seed the tracker with the sources already examined in prior runs of this workspace. Best-effort. */
export async function seedCoverage(ws: WsCtx, cov: CoverageTracker): Promise<void> {
  if (!ws.hasWorkspace || !ws.wsId) return
  try {
    const ids = (await dbw.call('listCoverage', ws.wsId)) as number[]
    for (const id of ids) if (Number.isInteger(id)) cov.examined.add(id)
  } catch {
    /* persistence is best-effort — a read failure just means an empty seed */
  }
}

/** Persist the cumulative examined set back to disk (idempotent). Best-effort. */
export async function persistCoverage(ws: WsCtx, cov: CoverageTracker): Promise<void> {
  if (!ws.hasWorkspace || !ws.wsId || cov.examined.size === 0) return
  try {
    await dbw.call('markCoverage', ws.wsId, [...cov.examined])
  } catch {
    /* best-effort */
  }
}

/** Format the "resume from here" block — pure, so it's unit-testable. Empty string when there is no
 *  prior state (a fresh investigation gets no resume preamble). */
export function formatResumeBlock(p: { plan: PlanStep[]; notes: string; events: number; iocs: number; examined: number; total: number }): string {
  const hasState = p.plan.length > 0 || p.notes.trim() !== '' || p.events > 0 || p.iocs > 0 || p.examined > 0
  if (!hasState) return ''
  const mark = (s: PlanStep): string => `    [${s.status === 'done' ? 'x' : s.status === 'active' ? '→' : ' '}] ${s.text}`
  const lines = [
    'INVESTIGATION IN PROGRESS — resume from here. This state persists across sessions; do NOT re-derive or re-examine what is already recorded below.'
  ]
  if (p.plan.length > 0) {
    lines.push('- Plan (keep it current with update_plan as you work):')
    for (const s of p.plan) lines.push(mark(s))
  }
  if (p.notes.trim() !== '') lines.push(`- Progress: ${p.notes.trim()}`)
  lines.push(
    `- Recorded so far: ${p.events} event(s), ${p.iocs} IOC(s); examined ${p.examined}/${p.total} source(s). ` +
      'Use list_events / list_iocs / review_coverage for detail, and pick up from the UNTOUCHED sources rather than re-walking covered ones. ' +
      'Save where you stop with save_progress so the next session resumes cleanly.'
  )
  return lines.join('\n')
}

/** Load the investigation state + findings counts and render the resume block. Best-effort (empty on
 *  error). `cov` should already be seeded so the coverage count reflects cumulative examination. */
export async function loadResumeBlock(ws: WsCtx, cov: CoverageTracker): Promise<string> {
  if (!ws.hasWorkspace || !ws.wsId) return ''
  try {
    const [inv, events, iocs] = await Promise.all([
      dbw.call('getInvestigation', ws.wsId) as Promise<{ plan: PlanStep[]; notes: string }>,
      dbw.call('listEvents', ws.wsId) as Promise<unknown[]>,
      dbw.call('listIocs', ws.wsId) as Promise<unknown[]>
    ])
    const universe = coverageUniverse(ws.sources)
    const examined = universe.filter((s) => cov.examined.has(s.sourceId)).length
    return formatResumeBlock({
      plan: Array.isArray(inv?.plan) ? inv.plan : [],
      notes: typeof inv?.notes === 'string' ? inv.notes : '',
      events: Array.isArray(events) ? events.length : 0,
      iocs: Array.isArray(iocs) ? iocs.length : 0,
      examined,
      total: universe.length
    })
  } catch {
    return ''
  }
}
