import { describe, expect, it } from 'vitest'
import { formatResumeBlock, type PlanStep } from './resume'

const step = (text: string, status: PlanStep['status'] = 'pending'): PlanStep => ({ text, status })

describe('formatResumeBlock', () => {
  it('returns empty when there is no prior state (fresh investigation)', () => {
    expect(formatResumeBlock({ plan: [], notes: '', events: 0, iocs: 0, examined: 0, total: 5 })).toBe('')
  })

  it('renders the plan with status markers, notes, and a findings/coverage roll-up', () => {
    const out = formatResumeBlock({
      plan: [step('Triage DESKTOP-X', 'done'), step('Check rclone exfil', 'active'), step('Review browser history')],
      notes: 'last lead: Compress-Archive ZIP at 19:57; next: confirm rclone target',
      events: 12,
      iocs: 8,
      examined: 14,
      total: 22
    })
    expect(out).toContain('[x] Triage DESKTOP-X')
    expect(out).toContain('[→] Check rclone exfil')
    expect(out).toContain('[ ] Review browser history')
    expect(out).toContain('last lead: Compress-Archive ZIP')
    expect(out).toContain('12 event(s), 8 IOC(s); examined 14/22 source(s)')
    expect(out).toContain('review_coverage')
  })

  it('fires from coverage alone even with an empty plan and notes', () => {
    const out = formatResumeBlock({ plan: [], notes: '', events: 0, iocs: 0, examined: 3, total: 10 })
    expect(out).not.toBe('')
    expect(out).toContain('examined 3/10')
  })
})
