import { describe, expect, it } from 'vitest'
import { coverageNudge, coverageUniverse, isTriageRun, newCoverage, untouchedSources, glimpsedSources } from './coverage'
import type { CoverageTracker, WsCtx, WsSource } from './types'

const src = (sourceId: number, name: string, rowCount: number, extra: Partial<WsSource> = {}): WsSource => ({
  sourceId,
  tabId: `ws:${sourceId}`,
  name,
  columns: [],
  rowCount,
  ...extra
})

const ws = (sources: WsSource[]): WsCtx => ({ hasWorkspace: true, wsId: 'w', sources })

const cov = (examined: number[], recordedEvents = 0, seenInSearch: number[] = []): CoverageTracker => ({
  startedAt: Date.now(),
  examined: new Set(examined),
  seenInSearch: new Set(seenInSearch),
  recordedEvents
})

describe('coverageUniverse', () => {
  it('excludes derived sources (the materialized Timeline)', () => {
    const all = [src(1, 'MFT', 100), src(2, 'Timeline', 50, { derived: true })]
    expect(coverageUniverse(all).map((s) => s.name)).toEqual(['MFT'])
  })
})

describe('untouchedSources', () => {
  it('returns unexamined real sources, biggest first', () => {
    const all = [src(1, 'MFT', 100), src(2, 'Amcache', 9000), src(3, 'Reg', 5), src(9, 'TL', 1, { derived: true })]
    const out = untouchedSources(all, cov([1]))
    expect(out.map((s) => s.name)).toEqual(['Amcache', 'Reg']) // examined MFT gone, derived gone, sorted desc
  })
})

describe('isTriageRun', () => {
  it('is true once 3+ sources examined or any event recorded', () => {
    expect(isTriageRun(cov([1, 2, 3]))).toBe(true)
    expect(isTriageRun(cov([1], 1))).toBe(true)
  })
  it('is false for a narrow, eventless run', () => {
    expect(isTriageRun(cov([1, 2]))).toBe(false)
    expect(isTriageRun(newCoverage())).toBe(false)
  })
})

describe('coverageNudge', () => {
  const all = [src(1, 'MFT', 100), src(2, 'Amcache', 9000), src(3, 'Hindsight — Timeline', 1613, { group: 'HOST-A' })]

  // Group-qualified, matching how a source is actually addressed — hosts share filenames, so a bare
  // name in the nudge is not something the agent can act on directly.
  it('names the untouched sources as group/name with row counts, once triage is underway', () => {
    const out = coverageNudge(ws(all), cov([1, 2, 9]), false)
    expect(out).toContain('HOST-A/Hindsight — Timeline (1,613 rows)')
    expect(out).toContain('review_coverage')
    expect(out).not.toContain('MFT (') // examined → not listed
  })

  it('leaves an ungrouped source unqualified rather than inventing a prefix', () => {
    const loose = [src(1, 'MFT', 100), src(2, 'loose.csv', 5)]
    expect(coverageNudge(ws(loose), cov([1], 1), false)).toContain('loose.csv (5 rows)')
  })

  it('returns null when every (non-derived) source has been examined', () => {
    expect(coverageNudge(ws(all), cov([1, 2, 3]), false)).toBeNull()
  })

  it('returns null for a narrow question (not a triage run)', () => {
    expect(coverageNudge(ws(all), cov([1]), false)).toBeNull()
  })

  it('returns null once already nudged (fires at most once)', () => {
    expect(coverageNudge(ws(all), cov([1, 2], 1), true)).toBeNull()
  })

  it('ignores a derived Timeline source when deciding completeness', () => {
    const withTl = [...all, src(8, 'Timeline', 200, { derived: true })]
    // examined every real source; only the derived Timeline is "untouched" → no nudge
    expect(coverageNudge(ws(withTl), cov([1, 2, 3], 1), false)).toBeNull()
  })

  it('returns null when there is no workspace', () => {
    expect(coverageNudge({ hasWorkspace: false, sources: [] }, cov([1, 2, 3], 2), false)).toBeNull()
  })
})

describe('glimpsedSources', () => {
  const all = [src(1, 'MFT', 100), src(2, 'Amcache', 50), src(3, 'Prefetch', 10)]

  // A cross-source search that returned rows means the agent HAS seen this source's data. Calling it
  // "never touched" sent it back to re-read sources it had already built findings from.
  it('separates search-only sources from never-touched ones', () => {
    const c = cov([1], 0, [2])
    expect(glimpsedSources(all, c).map((s) => s.name)).toEqual(['Amcache'])
    expect(untouchedSources(all, c).map((s) => s.name)).toEqual(['Prefetch'])
  })

  it('does not double-count a source that was properly examined', () => {
    const c = cov([2], 0, [2])
    expect(glimpsedSources(all, c)).toEqual([])
    expect(untouchedSources(all, c).map((s) => s.name)).toEqual(['MFT', 'Prefetch'])
  })

  it('keeps search-only sources out of the pre-conclusion nudge', () => {
    const c = cov([1, 3], 1, [2])
    expect(coverageNudge(ws(all), c, false)).toBeNull()
  })
})
