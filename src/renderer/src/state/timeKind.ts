import type { TimeKind } from './csvTypes'

// Renderer-side single-value time classifier — a small mirror of the ingest-time detector in
// src/main/csv/coltypes.ts (the source of truth). Used so a right-click on a cell can offer
// time pivots even when column-level detection was conservative (e.g. a mixed column).

// Keep in sync with src/main/csv/coltypes.ts — allows a space before the timezone offset.
const ISO_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)?(?: ?(?:Z|[+-]\d{2}:?\d{2}))?$/
const EPOCH_S_MIN = 946_684_800 // 2000-01-01Z
const EPOCH_S_MAX = 4_102_444_800 // 2100-01-01Z

/**
 * Parse an `<input type="datetime-local">` value as epoch SECONDS, interpreting it as UTC so
 * it lines up with how SQLite's unixepoch() reads offset-less column values. Empty → undefined.
 */
export function dtLocalToEpoch(v: string): number | undefined {
  if (!v) return undefined
  const withSeconds = v.length === 16 ? `${v}:00` : v // YYYY-MM-DDTHH:MM[:SS]
  const ms = Date.parse(`${withSeconds}Z`)
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000)
}

/** A `datetime-local` input value (UTC) from epoch seconds. */
export function epochToDtLocal(sec: number): string {
  const d = new Date(sec * 1000)
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 19)
}

/** Compact UTC label for a chip: "2025-03-25 18:04Z". */
export function epochToLabel(sec: number): string {
  const d = new Date(sec * 1000)
  return Number.isNaN(d.getTime()) ? String(sec) : `${d.toISOString().slice(0, 16).replace('T', ' ')}Z`
}

/**
 * Convert a time CELL's native value to epoch seconds, matching how SQLite's unixepoch() reads
 * the column (so a cell-derived bound lines up with the column's own values):
 *  • epoch_s/ms → the number itself; • iso → normalise to a parseable ISO string, treating an
 *  offset-less value as UTC (as SQLite does). Returns undefined if it can't be parsed.
 */
export function cellTimeToEpoch(value: string, tkind: TimeKind): number | undefined {
  const s = (value ?? '').trim()
  if (s === '') return undefined
  if (tkind === 'epoch_s') return Number.isFinite(Number(s)) ? Math.floor(Number(s)) : undefined
  if (tkind === 'epoch_ms') return Number.isFinite(Number(s)) ? Math.floor(Number(s) / 1000) : undefined
  // iso: "2025-03-25 18:04:40.954 +00:00" → "2025-03-25T18:04:40.954+00:00"; offset-less → +Z
  let iso = s.replace(/^(\d{4}-\d{2}-\d{2})[ T]/, '$1T').replace(/\s+([+-]\d{2}:?\d{2}|Z)$/i, '$1')
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(iso)) iso += 'Z'
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000)
}

export function classifyCellTime(value: string): TimeKind | null {
  const s = (value ?? '').trim()
  if (s === '') return null
  if (ISO_RE.test(s)) return 'iso'
  if (/^\d{13}$/.test(s)) {
    const n = Number(s)
    if (n >= EPOCH_S_MIN * 1000 && n <= EPOCH_S_MAX * 1000) return 'epoch_ms'
  }
  if (/^\d{10}$/.test(s)) {
    const n = Number(s)
    if (n >= EPOCH_S_MIN && n <= EPOCH_S_MAX) return 'epoch_s'
  }
  return null
}
