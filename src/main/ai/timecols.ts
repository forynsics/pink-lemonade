// Pure time-column helpers for the AI toolbox. Detection is automatic (ingest tags each column with a
// TimeKind); these helpers only ENUMERATE a source's time columns and resolve the one a tool was told
// to use — they never silently pick a column when the choice is contextual (that's the model's call).
// Electron-free so they can be unit-tested directly.

import { classifyTime, isEventTime, isPlausibleEpoch, TIME_SENTINEL_FLOOR, timeCeiling } from '../csv/coltypes'
import { resolveCol } from './colmap'
import type { WsSource } from './types'

export interface TimeCol {
  /** Positional SQL id (c0..cN). */
  id: string
  /** Display header. */
  label: string
  /** Detected kind — feeds the SQL timerange filter's `tkind`. */
  kind: string
}

/** Every column of a source detected as a time column, in positional order. */
export function timeColumnsOf(src: WsSource): TimeCol[] {
  return (src.columns ?? []).filter((c) => c.time).map((c) => ({ id: c.name, label: c.original, kind: c.time as string }))
}

/** Resolve the single time column a tool should filter on. An explicit ref wins (and must be a time
 *  column); otherwise the sole time column is used. Multiple-and-unspecified throws an informative
 *  error listing the options so the MODEL chooses with its context — we never guess. No time column
 *  at all also throws. */
export function resolveTimeColumn(src: WsSource, ref?: unknown): TimeCol {
  const cols = timeColumnsOf(src)
  const list = (): string => cols.map((c) => `${c.label}=${c.id}`).join(', ')
  if (cols.length === 0) throw new Error(`Source "${src.name}" has no detected time column, so it can't be time-filtered.`)

  const raw = ref == null ? '' : String(ref).trim()
  if (raw) {
    const wanted = resolveCol(raw, src.columns)
    const match = cols.find((c) => c.id === wanted)
    if (!match) throw new Error(`"${raw}" is not a time column in "${src.name}". Time columns: ${list()}.`)
    return match
  }
  if (cols.length === 1) return cols[0]
  throw new Error(`Source "${src.name}" has multiple time columns — pass time_column to choose. Options: ${list()}.`)
}

/** One time column's own epoch-second span over a set of matched rows. `kind` is the column's
 *  display header verbatim ("Created0x10", "Receive Time", …) — the timeline plots/groups by this. */
export interface ColSpan {
  kind: string
  /** Positional SQL id (c<n>) of the column. */
  colRef: string
  tsMin: number
  tsMax: number
}

/** Which time columns to consider for an evidence item: just `timeColRef` when it resolves (the
 *  per-evidence override), otherwise all of the source's detected time columns. */
function spanCols(src: WsSource, timeColRef?: unknown): TimeCol[] {
  if (timeColRef != null && String(timeColRef).trim()) {
    try {
      return [resolveTimeColumn(src, timeColRef)]
    } catch {
      return timeColumnsOf(src)
    }
  }
  return timeColumnsOf(src)
}

/** Per-time-column epoch-second spans of a set of matched rows — one entry per time column that has
 *  at least one parseable value. Unlike a single min–max envelope (which smears semantically-different
 *  timestamps like Created vs Modified into one bar — a row created months ago but modified yesterday
 *  spans months), this keeps each column's own span so the timeline can split BY kind (one row each). */
export function spansByColumn(src: WsSource, rows: string[][], timeColRef?: unknown): ColSpan[] {
  const out: ColSpan[] = []
  for (const tc of spanCols(src, timeColRef)) {
    const i = (src.columns ?? []).findIndex((c) => c.name === tc.id)
    if (i < 0) continue
    let lo: number | null = null
    let hi: number | null = null
    for (const row of rows) {
      const ep = toEpochSeconds(row[i])
      if (ep == null) continue
      if (lo == null || ep < lo) lo = ep
      if (hi == null || ep > hi) hi = ep
    }
    if (lo != null && hi != null) out.push({ kind: tc.label, colRef: tc.id, tsMin: lo, tsMax: hi })
  }
  return out
}

// Timestamp plausibility lives in csv/coltypes so the DB layer can apply the SAME rule when it
// derives an event's span; re-exported here for the tool layer.
export { TIME_SENTINEL_FLOOR, timeCeiling, isPlausibleEpoch, isEventTime }

/** The spans whose timestamps are impossible for recorded evidence (epoch sentinels, future dates).
 *  These are EXCLUDED from an event's span so one bogus value can't anchor it — but they are never
 *  discarded: an impossible timestamp is itself forensically interesting (timestomping, a forged PE
 *  link date), so callers surface it rather than swallow it. */
export function implausibleSpans(spans: ColSpan[], nowMs?: number): ColSpan[] {
  return spans.filter((s) => !isPlausibleEpoch(s.tsMin, nowMs) || !isPlausibleEpoch(s.tsMax, nowMs))
}

/** The overall epoch-second envelope across per-column spans (min of mins, max of maxes), counting only
 *  PLAUSIBLE timestamps, or {null,null} when none qualify. Stored on event_evidence as the whole-evidence
 *  span the constellation/Timeline anchors on. */
export function envelopeOf(spans: ColSpan[], nowMs?: number): { tsMin: number | null; tsMax: number | null } {
  // Two filters, and the order matters.
  //
  // 1. SEMANTICS. Only columns that mean "when this happened" may date the event. Collection stamps
  //    (SourceAccessed = when KAPE read the file) and reference dates (a LNK target's MACE, a PE
  //    LinkDate) are real timestamps of the WRONG THING: a logon event was reporting a
  //    span from the OS binary's install date to the moment of collection, which is where it
  //    would then plot on the analyst's Timeline.
  // 2. PLAUSIBILITY. A sentinel (Amcache LinkDate 1970) or future-dated value can't anchor it either.
  //
  // Both filters only affect the HEADLINE span. The per-kind `times` (spansByColumn) still report
  // every column truthfully — a timestomped Target date is itself a finding.
  const dating = spans.filter((s) => isEventTime(s.kind))
  // Fall back to all spans when a source offers nothing but reference/collection columns (a jump list
  // is largely target MACE). Better a span from the wrong clock, clearly visible per-kind, than an
  // event silently losing its place on the Timeline.
  const considered = dating.length > 0 ? dating : spans
  const real: number[] = []
  for (const s of considered) {
    if (isPlausibleEpoch(s.tsMin, nowMs)) real.push(s.tsMin)
    if (isPlausibleEpoch(s.tsMax, nowMs)) real.push(s.tsMax)
  }
  if (real.length === 0) return { tsMin: null, tsMax: null } // nothing plausible → the event is undated
  return { tsMin: Math.min(...real), tsMax: Math.max(...real) }
}

/** The epoch-second min–max span of a set of matched rows' time cells (the envelope across all the
 *  considered time columns). No production caller — the real path composes envelopeOf(spansByColumn(…))
 *  inline — but kept as the TEST SEAM for exactly that composition, including the event-vs-metadata
 *  time-semantics behavior (an MFT row dates by creation, not by its modification stamp). */
export function spanOf(src: WsSource, rows: string[][], timeColRef?: unknown): { tsMin: number | null; tsMax: number | null } {
  return envelopeOf(spansByColumn(src, rows, timeColRef))
}

/** Parse an ISO-8601 or epoch (seconds/millis) string to epoch SECONDS, or null if unparseable.
 *  The timerange filter wants epoch-second bounds regardless of the column's kind, so converting here
 *  lets a tool accept either an ISO timestamp or a raw epoch from the model. */
export function toEpochSeconds(value: unknown): number | null {
  const s = String(value ?? '').trim()
  if (!s) return null
  const kind = classifyTime(s)
  if (kind === 'epoch_s') return Number(s)
  if (kind === 'epoch_ms') return Math.trunc(Number(s) / 1000)
  // ISO/date text. A timestamp with NO timezone is UTC here: forensic artifacts (MFT, EVTX, Hayabusa, …)
  // emit UTC, and the SQL layer already parses these columns with SQLite unixepoch() (which treats a
  // tz-naive string as UTC). Plain JS Date.parse would instead read a tz-naive string as LOCAL time,
  // shifting the Timeline by the analyst's offset and disagreeing with the grid — so normalize tz-naive
  // values to UTC. Strings that DO carry a Z/±offset are parsed as-is (the offset is respected).
  const hasTz = /(?:Z|[+-]\d{2}:?\d{2})$/.test(s)
  let t: number
  if (hasTz) {
    t = Date.parse(s)
  } else {
    let iso = s.replace(' ', 'T')
    if (!iso.includes('T')) iso += 'T00:00:00' // date-only
    t = Date.parse(iso + 'Z')
  }
  return Number.isFinite(t) ? Math.trunc(t / 1000) : null
}
