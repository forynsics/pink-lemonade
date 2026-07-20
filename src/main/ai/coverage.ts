// Triage coverage — the deterministic, app-owned guard against the model triaging lead-to-lead and
// silently dropping sources nothing pointed it to (the "missed the second browser-history export"
// failure mode). It tracks which loaded sources the agent has actually examined with a data tool, and
// produces a one-time "before you conclude" nudge naming the untouched ones. Pure + testable: no IO,
// no model — the agent loops (HTTP engine + Claude Code SDK runner) own a tracker and consult these.

import type { CoverageTracker, WsCtx, WsSource } from './types'

/** A fresh per-run tracker. */
export function newCoverage(): CoverageTracker {
  return { examined: new Set<number>(), seenInSearch: new Set<number>(), recordedEvents: 0, startedAt: Date.now() }
}

/** Sources that count toward coverage: real imported artifacts. Excludes DERIVED sources (the
 *  materialized Timeline), which are built FROM the investigation rather than triaged. */
export function coverageUniverse(sources: WsSource[]): WsSource[] {
  return sources.filter((s) => !s.derived)
}

/** Sources not yet examined with a data tool. Biggest (most rows) first — a populated artifact is the
 *  one most likely to hide activity; a 0-row source is dismissed in a line. */
export function untouchedSources(sources: WsSource[], cov: CoverageTracker): WsSource[] {
  return coverageUniverse(sources)
    .filter((s) => !cov.examined.has(s.sourceId) && !cov.seenInSearch.has(s.sourceId))
    .sort((a, b) => b.rowCount - a.rowCount)
}

/** Sources the agent has only GLIMPSED — a cross-source search returned their rows, but it never
 *  opened them directly. Worth finishing, but not the same gap as a source nothing has ever read. */
export function glimpsedSources(sources: WsSource[], cov: CoverageTracker): WsSource[] {
  return coverageUniverse(sources)
    .filter((s) => !cov.examined.has(s.sourceId) && cov.seenInSearch.has(s.sourceId))
    .sort((a, b) => b.rowCount - a.rowCount)
}

/** Whether the run looks like a TRIAGE — broad enough that source coverage matters — so a one-off
 *  targeted question ("what's in the MFT?") isn't nagged about every other artifact. True once the
 *  agent has ranged across several sources or concluded at least one event. */
export function isTriageRun(cov: CoverageTracker): boolean {
  return cov.examined.size >= 3 || cov.recordedEvents >= 1
}

const NUDGE_LIST_CAP = 30

/** The one-time "before you conclude" coverage nudge — or null when not warranted. `alreadyNudged`
 *  guards against looping (we nudge at most once per run). Lists the untouched sources with row counts
 *  and host so the model can dismiss the empty ones fast and go investigate the populated ones. */
export function coverageNudge(ws: WsCtx, cov: CoverageTracker, alreadyNudged: boolean): string | null {
  if (alreadyNudged || !ws.hasWorkspace) return null
  if (!isTriageRun(cov)) return null
  const untouched = untouchedSources(ws.sources, cov)
  if (untouched.length === 0) return null
  const list = untouched
    .slice(0, NUDGE_LIST_CAP)
    .map((s) => `${s.group ? `${s.group}/` : ''}${s.name} (${s.rowCount.toLocaleString()} rows)`)
    .join('; ')
  const more = untouched.length > NUDGE_LIST_CAP ? ` …and ${untouched.length - NUDGE_LIST_CAP} more` : ''
  return (
    `[automatic coverage check] Before you conclude this triage: ${untouched.length} loaded source(s) have NOT been examined with any data tool yet — ${list}${more}. ` +
    'For EACH, either investigate it (get_distinct / find_rows / get_all_rows / query_workspace) or state explicitly why it can be skipped. ' +
    'A 0-row source you can dismiss in a line; a populated one — e.g. a second browser-history export — may hold activity no lead surfaced. ' +
    'Do not treat triage as complete until every source is accounted for. (Call review_coverage anytime to see what remains.)'
  )
}
