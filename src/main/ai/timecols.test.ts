import { describe, it, expect } from 'vitest'
import { timeColumnsOf, resolveTimeColumn, toEpochSeconds, spanOf, spansByColumn, envelopeOf } from './timecols'
import type { WsSource } from './types'

const src = (columns: WsSource['columns']): WsSource => ({ sourceId: 1, tabId: 'w:1', name: 'MFT', columns, rowCount: 10 })

describe('timeColumnsOf', () => {
  it('returns only the time-typed columns with id/label/kind', () => {
    const s = src([
      { name: 'c0', original: 'Path' },
      { name: 'c1', original: 'Created', time: 'iso' },
      { name: 'c2', original: 'Modified', time: 'iso' },
      { name: 'c3', original: 'Size' }
    ])
    expect(timeColumnsOf(s)).toEqual([
      { id: 'c1', label: 'Created', kind: 'iso' },
      { id: 'c2', label: 'Modified', kind: 'iso' }
    ])
  })
})

describe('resolveTimeColumn', () => {
  it('uses the sole time column when none is specified', () => {
    const s = src([{ name: 'c0', original: 'Path' }, { name: 'c1', original: 'Timestamp', time: 'epoch_s' }])
    expect(resolveTimeColumn(s)).toEqual({ id: 'c1', label: 'Timestamp', kind: 'epoch_s' })
  })

  it('resolves an explicit ref by id or label', () => {
    const s = src([{ name: 'c1', original: 'Created', time: 'iso' }, { name: 'c2', original: 'Modified', time: 'iso' }])
    expect(resolveTimeColumn(s, 'c2').id).toBe('c2')
    expect(resolveTimeColumn(s, 'Created').id).toBe('c1')
  })

  it('throws listing options when multiple time columns and none specified', () => {
    const s = src([{ name: 'c1', original: 'Created', time: 'iso' }, { name: 'c2', original: 'Modified', time: 'iso' }])
    expect(() => resolveTimeColumn(s)).toThrow(/multiple time columns/i)
    expect(() => resolveTimeColumn(s)).toThrow(/Created=c1, Modified=c2/)
  })

  it('throws when the ref is not a time column', () => {
    const s = src([{ name: 'c0', original: 'Path' }, { name: 'c1', original: 'Created', time: 'iso' }])
    expect(() => resolveTimeColumn(s, 'Path')).toThrow(/not a time column/i)
  })

  it('throws when the source has no time column', () => {
    expect(() => resolveTimeColumn(src([{ name: 'c0', original: 'Path' }]))).toThrow(/no detected time column/i)
  })
})

describe('spanOf', () => {
  const mft = src([
    { name: 'c0', original: 'Path' },
    { name: 'c1', original: 'Created', time: 'iso' },
    { name: 'c2', original: 'Modified', time: 'iso' }
  ])

  it('spans min–max across all time columns of the matched rows', () => {
    const rows = [
      ['a.exe', '2024-06-13T10:00:00Z', '2024-06-13T12:00:00Z'],
      ['a.exe', '2024-06-13T09:00:00Z', '2024-06-13T11:00:00Z']
    ]
    expect(spanOf(mft, rows)).toEqual({
      tsMin: Date.parse('2024-06-13T09:00:00Z') / 1000,
      tsMax: Date.parse('2024-06-13T12:00:00Z') / 1000
    })
  })

  it('honours a time_column override (only that column counts)', () => {
    const rows = [['a.exe', '2024-06-13T10:00:00Z', '2024-06-13T12:00:00Z']]
    expect(spanOf(mft, rows, 'Created')).toEqual({
      tsMin: Date.parse('2024-06-13T10:00:00Z') / 1000,
      tsMax: Date.parse('2024-06-13T10:00:00Z') / 1000
    })
  })

  it('returns nulls when no time column has parseable values', () => {
    const s = src([{ name: 'c0', original: 'Path' }])
    expect(spanOf(s, [['a.exe']])).toEqual({ tsMin: null, tsMax: null })
  })
})

describe('spansByColumn', () => {
  const mft = src([
    { name: 'c0', original: 'Path' },
    { name: 'c1', original: 'Created', time: 'iso' },
    { name: 'c2', original: 'Modified', time: 'iso' }
  ])

  it('keeps each time column as its own span (kind = header), not one smeared envelope', () => {
    const rows = [
      ['a.exe', '2024-01-01T00:00:00Z', '2024-06-13T12:00:00Z'],
      ['a.exe', '2024-01-02T00:00:00Z', '2024-06-13T10:00:00Z']
    ]
    expect(spansByColumn(mft, rows)).toEqual([
      { kind: 'Created', colRef: 'c1', tsMin: Date.parse('2024-01-01T00:00:00Z') / 1000, tsMax: Date.parse('2024-01-02T00:00:00Z') / 1000 },
      { kind: 'Modified', colRef: 'c2', tsMin: Date.parse('2024-06-13T10:00:00Z') / 1000, tsMax: Date.parse('2024-06-13T12:00:00Z') / 1000 }
    ])
  })

  it('honours a time_column override (only that column produces a span)', () => {
    const rows = [['a.exe', '2024-01-01T00:00:00Z', '2024-06-13T12:00:00Z']]
    expect(spansByColumn(mft, rows, 'Modified')).toEqual([
      { kind: 'Modified', colRef: 'c2', tsMin: Date.parse('2024-06-13T12:00:00Z') / 1000, tsMax: Date.parse('2024-06-13T12:00:00Z') / 1000 }
    ])
  })

  it('drops a time column with no parseable values', () => {
    const rows = [['a.exe', '', '2024-06-13T12:00:00Z']]
    expect(spansByColumn(mft, rows).map((s) => s.kind)).toEqual(['Modified'])
  })

  it('returns [] when the source has no time column', () => {
    expect(spansByColumn(src([{ name: 'c0', original: 'Path' }]), [['a.exe']])).toEqual([])
  })
})

describe('envelopeOf', () => {
  it('collapses per-column spans to the overall min/max', () => {
    expect(
      envelopeOf([
        { kind: 'Created', colRef: 'c1', tsMin: 100, tsMax: 200 },
        { kind: 'Modified', colRef: 'c2', tsMin: 50, tsMax: 500 }
      ])
    ).toEqual({ tsMin: 50, tsMax: 500 })
  })

  it('is {null,null} for no spans', () => {
    expect(envelopeOf([])).toEqual({ tsMin: null, tsMax: null })
  })
})

describe('toEpochSeconds', () => {
  it('passes epoch seconds through', () => {
    expect(toEpochSeconds('1718313258')).toBe(1718313258)
  })
  it('converts epoch millis to seconds', () => {
    expect(toEpochSeconds('1718313258123')).toBe(1718313258)
  })
  it('parses ISO-8601 to epoch seconds', () => {
    expect(toEpochSeconds('2024-06-13T21:14:18Z')).toBe(1718313258)
  })
  it('reads a timezone-NAIVE timestamp as UTC (not local), matching SQLite unixepoch', () => {
    // forensic artifacts (MFT etc.) emit UTC without a Z — must not be shifted by the analyst's offset
    expect(toEpochSeconds('2024-06-13 21:14:18')).toBe(1718313258) // space separator
    expect(toEpochSeconds('2024-06-13T21:14:18')).toBe(1718313258) // T, no Z
  })
  it('respects an explicit timezone offset', () => {
    expect(toEpochSeconds('2024-06-13T17:14:18-04:00')).toBe(1718313258) // 17:14 −04:00 == 21:14 UTC
  })
  it('treats a date-only value as UTC midnight', () => {
    expect(toEpochSeconds('2024-06-13')).toBe(Date.parse('2024-06-13T00:00:00Z') / 1000)
  })
  it('returns null for empty or junk', () => {
    expect(toEpochSeconds('')).toBeNull()
    expect(toEpochSeconds('not a date')).toBeNull()
    expect(toEpochSeconds(null)).toBeNull()
  })
})
