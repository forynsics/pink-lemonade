// Pure helpers that map a model-supplied column reference to the positional c<n> id the SQL layer
// requires. Kept electron-free (no dbClient/ipc imports) so it can be unit-tested directly.

import type { WsColumn } from './types'

/** Map a column reference to a c<n> id: pass through c<n>, else match a display name
 *  (case-insensitive). Anything else is returned unchanged (assertCol rejects it downstream). */
export function resolveCol(ref: unknown, columns: WsColumn[] | undefined): string {
  const s = String(ref ?? '')
  if (/^c\d+$/.test(s)) return s
  const hit = (columns ?? []).find((c) => c.original.toLowerCase() === s.toLowerCase() || c.name === s)
  return hit ? hit.name : s
}

/** Rewrite any `col` references inside a filter array to c<n> ids before normalization. */
export function resolveFilterCols(filters: unknown, columns: WsColumn[] | undefined): unknown {
  if (!Array.isArray(filters)) return filters
  return filters.map((f) => (f && typeof f === 'object' && 'col' in f ? { ...f, col: resolveCol((f as { col: unknown }).col, columns) } : f))
}

/**
 * Refuse a time filter aimed at a column that holds no time.
 *
 * `{col:"c7", op:"timerange", …}` on a numeric sequence-number column is structurally VALID — the
 * column resolves, the op and tkind are fine — so it survived normalization and simply matched
 * nothing. The caller got `{matchCount: 0}` and no warning, which in a forensics tool reads as
 * "nothing happened in that window": the worst possible output, and a conclusion an analyst might
 * act on. It was caught only because zero results in that window happened to be implausible.
 *
 * The machinery to reject this already existed one level down (an unparseable BOUND is refused); it
 * just was never applied to the column itself.
 */
export function timeFilterProblem(raw: unknown, columns: WsColumn[]): string | null {
  if (!Array.isArray(raw)) return null
  const timeCols = columns.filter((c) => c.time)
  for (const item of raw) {
    const f = item as Record<string, unknown>
    const op = String(f.op ?? '')
    if (op !== 'timerange' && op !== 'timearound') continue
    const ref = String(f.col ?? '')
    const col = columns.find((c) => c.name === ref || c.original === ref)
    if (!col || col.time) continue
    const others = timeCols.map((c) => `${c.name} (${c.original})`).join(', ')
    return (
      `"${col.original}" holds no timestamps, so a ${op} filter on it matches NOTHING and would have ` +
      `returned 0 rows as though the window were empty. ` +
      (others
        ? `Time columns in this source: ${others}.`
        : `This source has NO time column — filter it another way, or use a source that does.`)
    )
  }
  return null
}
