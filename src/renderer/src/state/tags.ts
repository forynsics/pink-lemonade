// Row-tag categories shared by the cell menu (set), the grid (colored marker), and the sidebar
// (counts). The `id` is what persists in the workspace db's `tags` table; never rename an id
// without a migration. Colors use Tailwind palette utilities (not citrus tokens) because tag
// severity is semantic, not part of the brand theme.

export type TagId = 'malicious' | 'suspicious' | 'unknown' | 'benign'

export interface TagDef {
  id: TagId
  label: string
  /** Left-edge marker bar in the grid (+ dark variant). */
  bar: string
  /** Small swatch in menus / legends (+ dark variant). */
  dot: string
}

export const TAG_DEFS: TagDef[] = [
  { id: 'malicious', label: 'Malicious', bar: 'bg-red-500 dark:bg-red-400', dot: 'bg-red-500 dark:bg-red-400' },
  { id: 'suspicious', label: 'Suspicious', bar: 'bg-amber-500 dark:bg-amber-400', dot: 'bg-amber-500 dark:bg-amber-400' },
  { id: 'unknown', label: 'Unknown', bar: 'bg-slate-400 dark:bg-slate-400', dot: 'bg-slate-400 dark:bg-slate-400' },
  { id: 'benign', label: 'Benign', bar: 'bg-emerald-500 dark:bg-emerald-400', dot: 'bg-emerald-500 dark:bg-emerald-400' }
]

const BY_ID: Record<string, TagDef> = Object.fromEntries(TAG_DEFS.map((t) => [t.id, t]))

export function tagDef(id: string | undefined): TagDef | undefined {
  return id ? BY_ID[id] : undefined
}
