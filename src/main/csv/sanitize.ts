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
