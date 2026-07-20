import { describe, it, expect } from 'vitest'
import { timeColumnsOf, resolveTimeColumn, toEpochSeconds, spanOf, spansByColumn, envelopeOf, implausibleSpans, isPlausibleEpoch } from './timecols'
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

  // CHANGED DELIBERATELY: this used to span Created..Modified across every row. An $MFT Modified
  // stamp describes the FILE (a copied binary keeps its build date), so it no longer dates an event
  // when a creation stamp is present — the span is now Created's own min–max.
  it('dates an MFT row by creation, not by its modification stamp', () => {
    const rows = [
      ['a.exe', '2024-06-13T10:00:00Z', '2024-06-13T12:00:00Z'],
      ['a.exe', '2024-06-13T09:00:00Z', '2024-06-13T11:00:00Z']
    ]
    expect(spanOf(mft, rows)).toEqual({
      tsMin: Date.parse('2024-06-13T09:00:00Z') / 1000,
      tsMax: Date.parse('2024-06-13T10:00:00Z') / 1000
    })
  })

  it('still spans min–max across the rows when the columns are both event times', () => {
    const evt = src([
      { name: 'c0', original: 'Path' },
      { name: 'c1', original: 'Created', time: 'iso' },
      { name: 'c2', original: 'Accessed', time: 'iso' }
    ])
    const rows = [
      ['a.exe', '2024-06-13T10:00:00Z', '2024-06-13T12:00:00Z'],
      ['a.exe', '2024-06-13T09:00:00Z', '2024-06-13T11:00:00Z']
    ]
    expect(spanOf(evt, rows)).toEqual({
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
    // Real epoch seconds: values below the 1980 sentinel floor are treated as non-timestamps.
    expect(
      envelopeOf([
        { kind: 'Created', colRef: 'c1', tsMin: 1_780_000_100, tsMax: 1_780_000_200 },
        { kind: 'Timestamp', colRef: 'c2', tsMin: 1_780_000_050, tsMax: 1_780_000_500 }
      ])
    ).toEqual({ tsMin: 1_780_000_050, tsMax: 1_780_000_500 })
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

describe('envelopeOf — sentinel timestamps', () => {
  it('ignores a 1970 sentinel so one bad column cannot anchor the event at the epoch', () => {
    // Amcache carries LinkDate 1970-01-01 for a binary with no link date; the real activity is 2026.
    expect(
      envelopeOf([
        { kind: 'LinkDate', colRef: 'c1', tsMin: 0, tsMax: 0 },
        { kind: 'Modified', colRef: 'c2', tsMin: 1_780_000_000, tsMax: 1_780_000_500 }
      ])
    ).toEqual({ tsMin: 1_780_000_000, tsMax: 1_780_000_500 })
  })

  it('clamps a span that straddles the floor to its real end', () => {
    expect(envelopeOf([{ kind: 'Created', colRef: 'c1', tsMin: 0, tsMax: 1_780_000_000 }])).toEqual({
      tsMin: 1_780_000_000,
      tsMax: 1_780_000_000
    })
  })

  it('reports undated when every timestamp is a sentinel', () => {
    expect(envelopeOf([{ kind: 'LinkDate', colRef: 'c1', tsMin: 0, tsMax: 0 }])).toEqual({ tsMin: null, tsMax: null })
  })
})

describe('timestamp plausibility — sentinels are excluded from the span, never discarded', () => {
  const FUTURE = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365 * 50 // ~2079

  it('rejects epoch sentinels and future dates, accepts real evidence times', () => {
    expect(isPlausibleEpoch(0)).toBe(false) // unix zero (1970)
    expect(isPlausibleEpoch(-11_644_473_600)).toBe(false) // FILETIME zero (1601)
    expect(isPlausibleEpoch(FUTURE)).toBe(false) // Amcache LinkDate 2079
    expect(isPlausibleEpoch(1_780_000_000)).toBe(true)
  })

  it('keeps a future-dated sentinel out of the event span', () => {
    expect(
      envelopeOf([
        { kind: 'LinkDate', colRef: 'c1', tsMin: FUTURE, tsMax: FUTURE },
        { kind: 'Modified', colRef: 'c2', tsMin: 1_780_000_000, tsMax: 1_780_000_500 }
      ])
    ).toEqual({ tsMin: 1_780_000_000, tsMax: 1_780_000_500 })
  })

  it('REPORTS the implausible spans so a bogus timestamp can be investigated, not swallowed', () => {
    const spans = [
      { kind: 'LinkDate', colRef: 'c1', tsMin: FUTURE, tsMax: FUTURE },
      { kind: 'Created', colRef: 'c2', tsMin: 0, tsMax: 0 },
      { kind: 'Modified', colRef: 'c3', tsMin: 1_780_000_000, tsMax: 1_780_000_500 }
    ]
    expect(implausibleSpans(spans).map((s) => s.kind)).toEqual(['LinkDate', 'Created'])
  })
})


describe('envelopeOf — only event-time columns may date an event', () => {
  const LOGON = 1700000000 // when the logon actually happened
  const INSTALL = 1600000000 // the OS binary's TargetCreated (its install date), years earlier
  const COLLECTED = 1710000000 // SourceAccessed — when the forensic tool read the artifact

  // The reported defect: a logon event came back spanning the binary's install date → collection
  // time, which is where it would plot on the analyst's Timeline.
  it('ignores install dates and collection stamps when a real event column exists', () => {
    expect(
      envelopeOf([
        { kind: 'TargetCreated', colRef: 'c1', tsMin: INSTALL, tsMax: INSTALL },
        { kind: 'SourceAccessed', colRef: 'c2', tsMin: COLLECTED, tsMax: COLLECTED },
        { kind: 'Timestamp', colRef: 'c3', tsMin: LOGON, tsMax: LOGON }
      ])
    ).toEqual({ tsMin: LOGON, tsMax: LOGON })
  })

  // The reported failure: an exfiltration was dated a MONTH EARLIER — ahead of the initial access
  // that led to it — because rclone.exe's LastModified0x10 is the binary's own build date, and the
  // roll-up took the minimum across every kind.
  it('does not date an exfiltration by the tool binary’s build date', () => {
    const BUILT = 1740000000 // rclone.exe LastModified0x10 — a month before the intrusion
    const RAN = 1743000000 // the transfer itself
    expect(
      envelopeOf([
        { kind: 'LastModified0x10', colRef: 'c1', tsMin: BUILT, tsMax: BUILT },
        { kind: 'Timestamp', colRef: 'c2', tsMin: RAN, tsMax: RAN }
      ])
    ).toEqual({ tsMin: RAN, tsMax: RAN })
  })

  // ...but when modification is ALL a source offers, it is the best clock available and must still
  // date the event rather than silently dropping it off the Timeline.
  it('falls back to a modification stamp when nothing else can date the event', () => {
    const WRITTEN = 1743000000
    expect(envelopeOf([{ kind: 'LastModified0x10', colRef: 'c1', tsMin: WRITTEN, tsMax: WRITTEN }])).toEqual({
      tsMin: WRITTEN,
      tsMax: WRITTEN
    })
  })

  it('ignores a shared document’s TargetModified, which predates the incident by years', () => {
    const DOC = 1400000000 // the document's own mtime, long before the event
    const ACCESS = 1700000500
    expect(
      envelopeOf([
        { kind: 'TargetModified', colRef: 'c1', tsMin: DOC, tsMax: DOC },
        { kind: 'LastAccessed', colRef: 'c2', tsMin: ACCESS, tsMax: ACCESS }
      ])
    ).toEqual({ tsMin: ACCESS, tsMax: ACCESS })
  })

  // A jump list is largely target MACE — better a span from the wrong clock, visible per-kind, than
  // an event silently losing its place on the Timeline.
  it('falls back to reference columns when a source offers nothing else', () => {
    expect(
      envelopeOf([
        { kind: 'TargetCreated', colRef: 'c1', tsMin: INSTALL, tsMax: INSTALL },
        { kind: 'SourceAccessed', colRef: 'c2', tsMin: COLLECTED, tsMax: COLLECTED }
      ])
    ).toEqual({ tsMin: INSTALL, tsMax: COLLECTED })
  })

  it('still drops implausible values from the event columns it keeps', () => {
    expect(
      envelopeOf([
        { kind: 'LinkDate', colRef: 'c1', tsMin: 0, tsMax: 0 },
        { kind: 'Created', colRef: 'c2', tsMin: 0, tsMax: 0 },
        { kind: 'Timestamp', colRef: 'c3', tsMin: LOGON, tsMax: LOGON }
      ])
    ).toEqual({ tsMin: LOGON, tsMax: LOGON })
  })
})
