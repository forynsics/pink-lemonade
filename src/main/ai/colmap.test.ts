import { describe, expect, it } from 'vitest'
import { resolveCol, resolveFilterCols, timeFilterProblem } from './colmap'
import type { WsColumn } from './types'

const COLS: WsColumn[] = [
  { name: 'c0', original: 'Timestamp', time: 'iso' },
  { name: 'c1', original: 'Source IP' },
  { name: 'c2', original: 'EventID' }
]

describe('resolveCol', () => {
  it('passes c<n> ids through unchanged', () => {
    expect(resolveCol('c2', COLS)).toBe('c2')
  })

  it('maps a display label to its c<n> id (case-insensitive)', () => {
    expect(resolveCol('Source IP', COLS)).toBe('c1')
    expect(resolveCol('source ip', COLS)).toBe('c1')
    expect(resolveCol('EVENTID', COLS)).toBe('c2')
  })

  it('returns an unknown reference unchanged (assertCol rejects it downstream)', () => {
    expect(resolveCol('nonsense', COLS)).toBe('nonsense')
    expect(resolveCol(undefined, COLS)).toBe('')
  })
})

describe('resolveFilterCols', () => {
  it('rewrites every filter col to a c<n> id', () => {
    const filters = [
      { col: 'Source IP', op: 'eq', value: '198.51.100.23' },
      { col: 'c2', op: 'in', values: ['4624', '4625'] },
      { op: 'tag', tags: ['malicious'] } // no col — passed through untouched
    ]
    const out = resolveFilterCols(filters, COLS) as Array<Record<string, unknown>>
    expect(out[0].col).toBe('c1')
    expect(out[1].col).toBe('c2')
    expect(out[2]).toEqual({ op: 'tag', tags: ['malicious'] })
    // Every col reference that survives is a positional id.
    for (const f of out) if ('col' in f) expect(String(f.col)).toMatch(/^c\d+$/)
  })

  it('leaves non-arrays alone', () => {
    expect(resolveFilterCols(undefined, COLS)).toBeUndefined()
  })
})

describe('timeFilterProblem', () => {
  const cols: WsColumn[] = [
    { name: 'c0', original: 'FullPath' },
    { name: 'c7', original: 'UpdateSequenceNumber', numeric: true },
    { name: 'c8', original: 'UpdateTimestamp', time: 'iso' }
  ]

  // The reported failure: a timerange on a numeric sequence-number column is structurally valid, so
  // it survived normalization and matched nothing. `{matchCount: 0}` in a forensics tool reads as
  // "nothing happened in that window" — the worst possible output.
  it('refuses a timerange on a column that holds no time', () => {
    const msg = timeFilterProblem([{ col: 'c7', op: 'timerange', tkind: 'iso', from: 1, to: 2 }], cols)
    expect(msg).toMatch(/UpdateSequenceNumber/)
    expect(msg).toMatch(/matches NOTHING/)
  })

  it('names the time columns that would have worked', () => {
    expect(timeFilterProblem([{ col: 'c7', op: 'timerange', tkind: 'iso' }], cols)).toMatch(/c8 \(UpdateTimestamp\)/)
  })

  it('says so plainly when the source has no time column at all', () => {
    const none: WsColumn[] = [{ name: 'c0', original: 'FullPath' }]
    expect(timeFilterProblem([{ col: 'c0', op: 'timerange', tkind: 'iso' }], none)).toMatch(/NO time column/)
  })

  it('allows a timerange on a real time column', () => {
    expect(timeFilterProblem([{ col: 'c8', op: 'timerange', tkind: 'iso' }], cols)).toBeNull()
  })

  it('catches timearound too, not just timerange', () => {
    expect(timeFilterProblem([{ col: 'c7', op: 'timearound', tkind: 'iso', value: 'x', deltaSec: 60 }], cols)).toMatch(/UpdateSequenceNumber/)
  })

  it('resolves a display label, not just a c-id', () => {
    expect(timeFilterProblem([{ col: 'UpdateSequenceNumber', op: 'timerange', tkind: 'iso' }], cols)).toMatch(/matches NOTHING/)
  })

  it('ignores non-time operators', () => {
    expect(timeFilterProblem([{ col: 'c7', op: 'eq', value: '5' }], cols)).toBeNull()
  })

  // An unknown column is rejected downstream with its own message; this check must not pre-empt it.
  it('stays quiet about a column it cannot resolve', () => {
    expect(timeFilterProblem([{ col: 'c99', op: 'timerange', tkind: 'iso' }], cols)).toBeNull()
  })
})
