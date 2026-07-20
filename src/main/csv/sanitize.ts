// Pure CSV header helpers — no Node/SQLite imports, fully unit-testable.
//
// Columns are addressed by *positional* safe names `c0..cN` (the real SQL identifier),
// with the original header text kept alongside for display. This makes the schema immune
// to weird/duplicate/SQL-keyword headers and is the SQL-injection boundary: only `c0..cN`
// ever reaches a query (see sql.ts assertCol).

import type { TimeKind } from './coltypes'

export interface ColumnMap {
  /** Safe positional SQL identifier: c0, c1, … */
  name: string
  /** Original header text, for display (de-duplicated, never empty). */
  original: string
  /** Detected timestamp kind, if this column reads as a time column (set after sampling). */
  time?: TimeKind
  /** True when the column's values are numbers, so SORTING must compare them numerically —
   *  otherwise a recency rank reads 0, 1, 10, 100, 2. Decided once at ingest, so the grid and the
   *  agent's tools agree instead of each sniffing their own sample. */
  numeric?: boolean
}

/** Map raw header cells to positional column ids, with cleaned, de-duplicated display names. */
export function sanitizeHeaders(raw: string[]): ColumnMap[] {
  const seen = new Map<string, number>()
  return raw.map((cell, i) => {
    let original = (cell ?? '').trim()
    if (original === '') original = `Column ${i + 1}`
    // disambiguate duplicate display names: "ip", "ip (2)", "ip (3)" …
    const count = seen.get(original) ?? 0
    seen.set(original, count + 1)
    if (count > 0) original = `${original} (${count + 1})`
    return { name: `c${i}`, original }
  })
}

/** Guess the delimiter of a CSV from its first line (tab / comma / pipe / semicolon). */
export function detectDelimiter(firstLine: string): string {
  const candidates: Array<[string, number]> = [
    ['\t', count(firstLine, '\t')],
    [',', count(firstLine, ',')],
    ['|', count(firstLine, '|')],
    [';', count(firstLine, ';')]
  ]
  candidates.sort((a, b) => b[1] - a[1])
  // default to comma if nothing stands out
  return candidates[0][1] > 0 ? candidates[0][0] : ','
}

function count(s: string, ch: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) if (s[i] === ch) n++
  return n
}

/**
 * Which row is the real header? Usually row 0 — but forensic tools routinely put a REPORT TITLE in a
 * merged cell on row 1 and the real header underneath.
 *
 * Hindsight does exactly that, and taking row 0 blindly labelled every column
 * "Hindsight Internet History Forensics (v2024.10)", "… (2)", "… (3)" while the real header
 * (Type/Timestamp/URL) was ingested as a DATA row. The columns become semantically anonymous, so
 * every query and every citation from that source is unreadable.
 *
 * The tell is DISTINCT values, not width: ExcelJS expands a merged range by REPEATING its value into
 * every covered cell, so Hindsight's title came back as 21 identical cells, not one. A real header row
 * carries many different labels. So row 0 holding at most one distinct value, with a more varied row
 * beneath it, is a banner. A genuinely single-column sheet has one distinct value in BOTH rows and is
 * left alone.
 */
export function headerRowIndex(rows: string[][]): number {
  const distinct = (r: string[] | undefined): number => new Set((r ?? []).map((c) => c.trim()).filter(Boolean)).size
  const width = Math.max(rows[0]?.length ?? 0, rows[1]?.length ?? 0)
  if (width < 2 || !rows[1]) return 0
  const first = distinct(rows[0])
  const second = distinct(rows[1])
  // A banner repeats: Hindsight's row 0 is 4 distinct values spanning 21 columns (a title plus
  // "URL Specific" / "Download Specific" group captions), while its real header is 21 of 21. Requiring
  // row 0 to be at most HALF distinct keeps a genuine header safe even when it repeats a label or two.
  return first * 2 <= width && second > first ? 1 : 0
}
