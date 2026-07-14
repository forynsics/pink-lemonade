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
