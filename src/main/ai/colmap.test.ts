import { describe, expect, it } from 'vitest'
import { resolveCol, resolveFilterCols } from './colmap'
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
