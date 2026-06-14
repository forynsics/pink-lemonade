// Lightweight column-type detection for time columns — pure + unit-tested. The CSV schema
// stays all-TEXT; this only tags a column so the UI can offer time filters and the SQL layer
// knows how to turn the column into epoch seconds.
//
// Supported (covers the bulk of SIEM/log exports without a normalized shadow column):
//   iso       ISO-8601 text — SQLite's unixepoch(col) parses it (T or space, Z/offset, date-only)
//   epoch_s   10-digit Unix seconds
//   epoch_ms  13-digit Unix milliseconds
// Messy formats (syslog "Jun 13 …", US "MM/DD/YYYY") are intentionally NOT detected — they'd
// need per-row JS normalization at ingest.

export type TimeKind = 'iso' | 'epoch_s' | 'epoch_ms'

// Date, optional time (T or space separator, optional seconds/fraction), optional timezone
// (Z or ±HH[:]MM) which may itself be preceded by a space — e.g. "2025-03-25 18:04:40.954 +00:00".
const ISO_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)?(?: ?(?:Z|[+-]\d{2}:?\d{2}))?$/
const EPOCH_S_MIN = 946_684_800 // 2000-01-01Z
const EPOCH_S_MAX = 4_102_444_800 // 2100-01-01Z

/** Classify a single value, or null if it isn't a recognised timestamp. */
export function classifyTime(value: string): TimeKind | null {
  const s = value.trim()
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

/** A header that reads like a timestamp — used to avoid mistaking numeric IDs for epochs. */
function looksLikeTimeName(header?: string): boolean {
  return !!header && /time|date|\bts\b|timestamp|datetime|epoch|seen|created|modified|occur|event/i.test(header)
}

/**
 * Decide a column's time kind from a sample of its values. Requires a dominant kind covering
 * ≥90% of the non-empty sample. Epoch detection additionally needs a time-ish header so a
 * column of 10-/13-digit IDs isn't misread as a timestamp; ISO text is unambiguous on its own.
 */
export function detectColumnTime(samples: string[], header?: string): TimeKind | null {
  const counts: Record<TimeKind, number> = { iso: 0, epoch_s: 0, epoch_ms: 0 }
  let nonEmpty = 0
  for (const v of samples) {
    if (v == null || v.trim() === '') continue
    nonEmpty++
    const k = classifyTime(v)
    if (k) counts[k]++
  }
  if (nonEmpty < 3) return null
  const [kind, n] = (Object.entries(counts) as [TimeKind, number][]).sort((a, b) => b[1] - a[1])[0]
  if (n / nonEmpty < 0.9) return null
  if ((kind === 'epoch_s' || kind === 'epoch_ms') && !looksLikeTimeName(header)) return null
  return kind
}
