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
// (Z or ±HH[:]MM) which may itself be preceded by a space — e.g. "2023-11-14 18:04:40.954 +00:00".
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
 * ≥90% of the non-empty sample. Epoch detection additionally needs a time-ish header AND a few
 * samples so a column of 10-/13-digit IDs isn't misread as a timestamp. ISO text is unambiguous
 * on its own, so even a single ISO value is accepted — this is what lets a single-row source
 * (e.g. a one-row RBCmd export whose only `DeletedOn` is "2023-11-09 12:18:52") get tagged.
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
  if (nonEmpty === 0) return null
  const [kind, n] = (Object.entries(counts) as [TimeKind, number][]).sort((a, b) => b[1] - a[1])[0]
  if (n === 0 || n / nonEmpty < 0.9) return null
  // Epoch values are bare numbers — demand a time-ish header and a few samples to avoid mistaking
  // numeric IDs for timestamps. ISO text is self-describing, so a lone value is enough.
  if (kind === 'epoch_s' || kind === 'epoch_ms') {
    if (!looksLikeTimeName(header) || nonEmpty < 3) return null
  }
  return kind
}

/**
 * Is this column numeric — i.e. should sorting compare it as a NUMBER rather than as text?
 *
 * Without this a recency rank sorts 0, 1, 10, 100, 101, 2 — so "the 25 most recent entries" is not
 * expressible at all on an AppCompatCache position, an MFT entry number, or a file size. The grid
 * used to sniff the LOADED PAGE instead, which meant a column could sort numerically on one screen
 * and alphabetically on the next; deciding once at ingest makes it stable and lets the agent's tools
 * share the same answer.
 *
 * Deliberately conservative:
 *  • a dominant 90% of the non-empty sample must parse as a plain number, and
 *  • a few values are required, so one lone "7" doesn't type a column of prose, and
 *  • anything longer than 15 digits is NOT numeric — sorting CASTs to REAL, and past 2^53 that
 *    silently reorders values (a 20-digit id would sort wrongly, which is worse than sorting as text).
 */
export function detectColumnNumeric(samples: string[]): boolean {
  let nonEmpty = 0
  let numeric = 0
  for (const v of samples) {
    const t = (v ?? '').trim()
    if (t === '') continue
    nonEmpty++
    if (!/^-?\d+(\.\d+)?$/.test(t)) continue
    if (t.replace(/[-.]/g, '').length > 15) return false // beyond REAL's exact-integer range
    numeric++
  }
  if (nonEmpty < 3) return false
  return numeric / nonEmpty >= 0.9
}

// ---- Timestamp plausibility ----
// Some artifacts carry impossible timestamps: Amcache reports LinkDate 1970-01-01 for a binary with no
// link date, or a far-future date like 2079 for a forged/odd PE header. Those must not anchor an event
// on the Timeline — but they are NEVER discarded: an impossible timestamp is itself forensically
// interesting (timestomping, a forged header), so callers surface it instead of swallowing it.

/** Below this a timestamp is a sentinel, not evidence: 1980-01-01 is the DOS/FAT epoch, so no real
 *  filesystem timestamp predates it. Unix zero (1970) and Windows FILETIME zero (1601) fall below. */
export const TIME_SENTINEL_FLOOR = 315532800 // 1980-01-01T00:00:00Z

/** Recorded evidence can't come from the future — past now (+1 day of clock skew) is forged/sentinel. */
export function timeCeiling(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / 1000) + 86400
}

/** Could this epoch-second value actually belong to collected evidence? */
export function isPlausibleEpoch(ts: number, nowMs?: number): boolean {
  return ts >= TIME_SENTINEL_FLOOR && ts <= timeCeiling(nowMs)
}

/**
 * What a time column MEANS, which decides whether it can date an event.
 *
 *  • `event`      — when something happened. The default, and the only kind that anchors an event.
 *  • `collection` — when the FORENSIC TOOL touched the artifact file. Eric Zimmerman's parsers stamp
 *                   Source{Created,Modified,Accessed} onto nearly every row; SourceAccessed is
 *                   effectively "when KAPE collected this", which is never when the incident happened.
 *  • `reference`  — a date belonging to an object the row merely POINTS AT: a LNK's target file MACE,
 *                   or a PE LinkDate (compile time). Real data, wrong clock — an RDP event dated by
 *                   `mstsc.exe`'s TargetCreated plots at the OS install date.
 *  • `metadata`   — the row's own file MACE stamps other than creation: LastModified / LastAccess /
 *                   record-change, from $MFT, USN or a directory listing. These describe the FILE's
 *                   history, not the action observed. A tool copied onto a host keeps its BUILD date
 *                   as LastModified, so an exfiltration event rolled up across it was dated a month
 *                   before the intrusion began — ahead of the initial access that led to it.
 *
 * This exists because an event's headline span was rolled up across every time column, so a genuine
 * logon reported a span starting at the OS binary's install date and ending at collection time.
 * Non-event kinds are still recorded and shown per-column — they are forensically useful, and a
 * timestomped Target date is itself a finding — they just cannot date the event.
 */
export type TimeSemantics = 'event' | 'collection' | 'reference' | 'metadata'

const COLLECTION_TIME = /^source(created|modified|accessed|written)/
const REFERENCE_TIME = /^(target(created|modified|accessed|written)|linkdate|compiletime|compiledon|peheadertime)/
// $MFT/USN modification stamps, with or without an attribute suffix (LastModified0x10, Modified0x30).
//
// Two kinds are deliberately ABSENT:
//  • CREATION — "the file appeared" IS an action, and the right clock for a dropped payload.
//  • ACCESS — something OPENED it, which is also an action. A LNK's LastAccessed is exactly when the
//    document was opened; classifying it as metadata re-broke the very case this system was built
//    for, re-dating a document-open to the document's own mtime years earlier.
//
// These still date an event when they are ALL a source offers (envelopeOf falls back to every span),
// so a file whose only stamp is LastModified — where modification really is the action — keeps its
// place on the Timeline.
const METADATA_TIME = /^(last(modified|written|recordchange)|(modified|changed|entrymodified)(0x[13]0)?$)/

export function timeSemantics(label: string): TimeSemantics {
  const k = String(label ?? '')
    .toLowerCase()
    .replace(/[\s_\-.]/g, '')
  if (COLLECTION_TIME.test(k)) return 'collection'
  if (REFERENCE_TIME.test(k)) return 'reference'
  if (METADATA_TIME.test(k)) return 'metadata'
  return 'event'
}

/** Can this column date an event? */
export function isEventTime(label: string): boolean {
  return timeSemantics(label) === 'event'
}

