// The Timeline: a curated, deterministic Plaso / l2t_csv-style super-timeline built from the recorded
// events (Artifact Constellation store). One row per (event × evidence × timestamp-KIND) — Created vs
// Modified kept distinct, the way a forensic super-timeline lays out each timestamp on its own line —
// sorted by time. Pure + deterministic: same events → same rows, every time (the determinism the AI's
// chat-window timeline never had). The visual surface (TimelinePanel) just renders these.

import type { CsvEvent } from './csvTypes'

/** One timeline entry — the l2t_csv-style columns. */
export interface TimelineRow {
  /** Epoch SECONDS for sorting; null = undated (sorts last). */
  epoch: number | null
  /** Span end (epoch s) when the evidence covers a range; null for an instant or undated. */
  endEpoch: number | null
  /** Time column (ISO-8601 UTC), or '' when undated. */
  time: string
  /** Timestamp KIND — the source column header ("Created0x10", "Modified", event time), or '(undated)'. */
  type: string
  /** Source artifact the evidence is in. */
  source: string
  /** Host/system/origin (the source's group label), or '' when ungrouped. */
  host: string
  /** User dimension — the account(s) an event involves, from its curated `users` attribution. */
  user: string
  /** The matched indicator/term that corroborates this entry — the readable provenance ('' for
   *  filter-based evidence, which has no single term). */
  matched: string
  /** How many rows in the source matched (the evidence-row count). */
  rows: number
  /** What happened + context (event label + ATT&CK technique). */
  description: string
  // ---- pivot payload (click a row → jump the grid to its exact evidence rows) ----
  sourceId: number
  rids: number[]
  eventId: string
}

/** Sentinel time for an undated/error row (Plaso convention, at our epoch-second precision). */
export const TIME_SENTINEL = '0000-00-00T00:00:00+00:00'

/** original_path sentinel marking the materialized Timeline source (kept in sync with db.ts). */
export const TIMELINE_SOURCE_MARKER = '<timeline>'

/** The l2t_csv-style column header the materialized Timeline source uses (Matched + Rows add readable
 *  provenance — the indicator that corroborates each entry and how many source rows matched). */
export const TIMELINE_HEADER = ['Time', 'Type', 'Source', 'Host', 'User', 'Description', 'Matched', 'Rows']

/** Hidden machinery columns appended to the MATERIALIZED Timeline source so a grid row can pivot back
 *  to its evidence (source id + the corroborating rowids). Never shown, exported, or filtered on —
 *  `isInternalTimelineColumn` gates them out of every display surface. */
export const TIMELINE_PIVOT_SOURCE_COL = '_sourceId'
export const TIMELINE_PIVOT_RIDS_COL = '_rids'
export const TIMELINE_PIVOT_HEADER = [TIMELINE_PIVOT_SOURCE_COL, TIMELINE_PIVOT_RIDS_COL]

/** True for the hidden pivot-address columns — used to drop them from the grid, picker, export, etc. */
export function isInternalTimelineColumn(original: string): boolean {
  return original === TIMELINE_PIVOT_SOURCE_COL || original === TIMELINE_PIVOT_RIDS_COL
}

/** Flatten the rows to a header + string cells for materializing as a grid source (Build Timeline).
 *  `withPivot` appends the hidden `(sourceId, rids)` address columns so the built grid can pivot to
 *  evidence; the CSV export path leaves them off. */
export function timelineToTable(rows: TimelineRow[], withPivot = false): { header: string[]; rows: string[][] } {
  return {
    header: withPivot ? [...TIMELINE_HEADER, ...TIMELINE_PIVOT_HEADER] : TIMELINE_HEADER,
    rows: rows.map((r) => {
      const cells = [r.time || TIME_SENTINEL, r.type, r.source, r.host, r.user, r.description, r.matched, String(r.rows)]
      return withPivot ? [...cells, String(r.sourceId), JSON.stringify(r.rids)] : cells
    })
  }
}

/** Epoch SECONDS → ISO-8601 UTC at second precision (…+00:00), the timeline's Time column. */
export function isoUtc(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString().replace(/\.\d{3}Z$/, '+00:00')
}

function describe(ev: CsvEvent): string {
  return ev.technique ? `${ev.label} [${ev.technique}]` : ev.label
}
/** The readable matched term, or '' for filter-based evidence (which has no single term). */
function matchedOf(m: string): string {
  return m && m !== 'filter' ? m : ''
}

/** Build the timeline rows from recorded events. `groupOf` resolves a source id to its group label
 *  (the Host column) — null when ungrouped. Rows are sorted by time ascending, undated last. */
export function buildTimelineRows(events: CsvEvent[], groupOf: (sourceId: number) => string | null): TimelineRow[] {
  const rows: TimelineRow[] = []
  const seen = new Set<string>()
  const push = (r: TimelineRow): void => {
    const key = `${r.eventId}|${r.sourceId}|${r.type}|${r.epoch}|${r.endEpoch}`
    if (seen.has(key)) return
    seen.add(key)
    rows.push(r)
  }
  for (const ev of events) {
    const desc = describe(ev)
    // The user dimension is the event's curated user attribution (the account(s) it involves).
    const userStr = (ev.users ?? []).join(', ')
    let datedForEvent = 0
    for (const e of ev.evidence) {
      const host = groupOf(e.sourceId) ?? ''
      const matched = matchedOf(e.matched)
      for (const s of e.spans ?? []) {
        datedForEvent++
        push({
          epoch: s.tsMin,
          endEpoch: s.tsMax > s.tsMin ? s.tsMax : null,
          time: isoUtc(s.tsMin),
          type: s.kind,
          source: e.sourceName,
          host,
          user: userStr,
          matched,
          rows: e.count,
          description: desc,
          sourceId: e.sourceId,
          rids: e.rids,
          eventId: ev.id
        })
      }
    }
    // An event with no dated evidence still belongs on the timeline — as a single undated entry.
    if (datedForEvent === 0) {
      const first = ev.evidence[0]
      push({
        epoch: null,
        endEpoch: null,
        time: '',
        type: '(undated)',
        source: first?.sourceName ?? '',
        host: first ? groupOf(first.sourceId) ?? '' : '',
        user: userStr,
        matched: matchedOf(first?.matched ?? ''),
        rows: first?.count ?? 0,
        description: desc,
        sourceId: first?.sourceId ?? -1,
        rids: first?.rids ?? [],
        eventId: ev.id
      })
    }
  }
  // Time ascending; undated (null) last. Stable tiebreak so the output is fully deterministic.
  rows.sort((a, b) => {
    if (a.epoch == null && b.epoch == null) return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0
    if (a.epoch == null) return 1
    if (b.epoch == null) return -1
    if (a.epoch !== b.epoch) return a.epoch - b.epoch
    if (a.source !== b.source) return a.source < b.source ? -1 : 1
    return a.type < b.type ? -1 : a.type > b.type ? 1 : 0
  })
  return rows
}

/** Serialize the rows to l2t_csv-style CSV (the TIMELINE_HEADER columns) for export. */
export function timelineToCsv(rows: TimelineRow[]): string {
  const esc = (v: string): string => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
  const table = timelineToTable(rows)
  const lines = [table.header.join(',')]
  for (const r of table.rows) lines.push(r.map((v) => esc(v)).join(','))
  return lines.join('\r\n')
}
