import { describe, it, expect } from 'vitest'
import {
  buildTimelineRows,
  timelineToCsv,
  timelineToTable,
  isoUtc,
  TIME_SENTINEL,
  TIMELINE_HEADER,
  TIMELINE_PIVOT_HEADER,
  isInternalTimelineColumn
} from './timeline'
import type { CsvEvent, CsvEventEvidence } from './csvTypes'

const ev = (id: string, label: string, evidence: CsvEventEvidence[], technique: string | null = null, users: string[] = []): CsvEvent => ({
  id,
  label,
  description: null,
  technique,
  createdAt: 0,
  actor: 'ai',
  users,
  evidence
})
const span = (kind: string, tsMin: number, tsMax = tsMin): { kind: string; colRef: string | null; tsMin: number; tsMax: number } => ({ kind, colRef: 'c1', tsMin, tsMax })
const evid = (sourceId: number, sourceName: string, matched: string, spans: ReturnType<typeof span>[], rids: number[] = [1, 2]): CsvEventEvidence => ({
  sourceId,
  sourceName,
  matched,
  count: rids.length,
  rids,
  spans,
  tsMin: spans.length ? Math.min(...spans.map((s) => s.tsMin)) : null,
  tsMax: spans.length ? Math.max(...spans.map((s) => s.tsMax)) : null
})

const T1 = Date.parse('2024-06-13T10:00:00Z') / 1000
const T2 = Date.parse('2024-06-13T12:00:00Z') / 1000
const groupOf = (id: number): string | null => (id === 1 ? 'DESKTOP-X' : id === 2 ? 'DC1' : null)

describe('buildTimelineRows', () => {
  it('emits one row per (evidence, timestamp-kind), keeping Created vs Modified distinct', () => {
    const rows = buildTimelineRows([ev('e1', 'Drop', [evid(1, 'MFT', 'evil.exe', [span('Created', T1), span('Modified', T2)])])], groupOf)
    expect(rows.map((r) => r.type)).toEqual(['Created', 'Modified'])
    expect(rows[0]).toMatchObject({ time: '2024-06-13T10:00:00+00:00', source: 'MFT', host: 'DESKTOP-X', user: '', sourceId: 1, matched: 'evil.exe', rows: 2 })
    expect(rows[0].description).toBe('Drop')
  })

  it('sorts by time ascending across events, undated last', () => {
    const rows = buildTimelineRows(
      [
        ev('late', 'Late', [evid(2, 'Sec', 'x', [span('Time', T2)])]),
        ev('early', 'Early', [evid(1, 'Amcache', 'y', [span('Time', T1)])]),
        ev('none', 'Undated', [evid(1, 'Reg', 'z', [])])
      ],
      groupOf
    )
    expect(rows.map((r) => r.eventId)).toEqual(['early', 'late', 'none'])
    expect(rows[2]).toMatchObject({ epoch: null, time: '', type: '(undated)', host: 'DESKTOP-X' })
  })

  it('marks a span as a range (endEpoch) and an instant (null end)', () => {
    const rows = buildTimelineRows([ev('e', 'E', [evid(1, 'S', 'm', [span('Range', T1, T2), span('Instant', T1)])])], groupOf)
    const byKind = Object.fromEntries(rows.map((r) => [r.type, r]))
    expect(byKind.Range.endEpoch).toBe(T2)
    expect(byKind.Instant.endEpoch).toBeNull()
  })

  it('shows ATT&CK technique in the description and blanks the host when ungrouped', () => {
    const rows = buildTimelineRows([ev('e', 'Exec', [evid(9, 'Prefetch', 'p.exe', [span('Run', T1)])], 'T1059')], groupOf)
    expect(rows[0].description).toBe('Exec [T1059]')
    expect(rows[0].matched).toBe('p.exe')
    expect(rows[0].host).toBe('')
  })

  it('dedupes identical (event, source, kind, time) rows', () => {
    const e = evid(1, 'S', 'm', [span('K', T1)])
    const rows = buildTimelineRows([ev('e', 'E', [e, e])], groupOf)
    expect(rows).toHaveLength(1)
  })

  it("fills the User column with the event's curated user attribution (dated + undated)", () => {
    const rows = buildTimelineRows(
      [
        ev('logon', 'Logon', [evid(1, 'Sec', 'x', [span('Time', T1)])], null, ['DESKTOP-X\\user1', 'SYSTEM']),
        ev('u', 'Undated', [evid(1, 'Reg', 'z', [])], null, ['DESKTOP-X\\user1'])
      ],
      groupOf
    )
    expect(rows[0].user).toBe('DESKTOP-X\\user1, SYSTEM')
    expect(rows[1].user).toBe('DESKTOP-X\\user1')
    // Flows through to the materialized table + CSV (User is the 5th column).
    expect(timelineToTable(rows).rows[0][4]).toBe('DESKTOP-X\\user1, SYSTEM')
    expect(timelineToCsv(rows).split('\r\n')[1]).toContain('DESKTOP-X\\user1, SYSTEM')
  })
})

describe('timelineToCsv', () => {
  it('writes the l2t_csv header + a sentinel time for undated rows + escapes commas', () => {
    const rows = buildTimelineRows(
      [ev('e', 'A, then B', [evid(1, 'MFT', 'filter', [span('Created', T1)])]), ev('u', 'Undated', [evid(1, 'Reg', 'z', [])])],
      groupOf
    )
    const csv = timelineToCsv(rows)
    const lines = csv.split('\r\n')
    expect(lines[0]).toBe('Time,Type,Source,Host,User,Description,Matched,Rows')
    expect(lines[1]).toContain('2024-06-13T10:00:00+00:00,Created,MFT,DESKTOP-X,,"A, then B",,2')
    expect(lines[2]).toContain(`${TIME_SENTINEL},(undated)`)
  })
})

describe('timelineToTable', () => {
  it('flattens rows to the l2t_csv header + cells, sentinel time for undated', () => {
    const rows = buildTimelineRows(
      [ev('e', 'Drop', [evid(1, 'MFT', 'x', [span('Created', T1)])]), ev('u', 'Undated', [evid(1, 'Reg', 'z', [])])],
      groupOf
    )
    const t = timelineToTable(rows)
    expect(t.header).toEqual(TIMELINE_HEADER)
    expect(t.rows[0]).toEqual(['2024-06-13T10:00:00+00:00', 'Created', 'MFT', 'DESKTOP-X', '', 'Drop', 'x', '2'])
    expect(t.rows[1][0]).toBe(TIME_SENTINEL)
  })

  it('appends the hidden (sourceId, rids) pivot columns when withPivot is set', () => {
    const rows = buildTimelineRows([ev('e', 'Drop', [evid(1, 'MFT', 'x', [span('Created', T1)])])], groupOf)
    const t = timelineToTable(rows, true)
    expect(t.header).toEqual([...TIMELINE_HEADER, ...TIMELINE_PIVOT_HEADER])
    expect(t.rows[0].length).toBe(TIMELINE_HEADER.length + 2)
    // Trailing two cells carry the evidence source id + its rowids as JSON, for the grid pivot.
    expect(t.rows[0].slice(-2)).toEqual(['1', '[1,2]'])
  })
})

describe('isInternalTimelineColumn', () => {
  it('flags only the hidden pivot machinery', () => {
    expect(TIMELINE_PIVOT_HEADER.every(isInternalTimelineColumn)).toBe(true)
    expect(isInternalTimelineColumn('Time')).toBe(false)
    expect(isInternalTimelineColumn('Description')).toBe(false)
  })
})

describe('isoUtc', () => {
  it('formats epoch seconds as ISO-8601 UTC at second precision', () => {
    expect(isoUtc(Date.parse('2024-06-13T21:14:18Z') / 1000)).toBe('2024-06-13T21:14:18+00:00')
  })
})
