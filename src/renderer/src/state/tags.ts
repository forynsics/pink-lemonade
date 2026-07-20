// Row-tag categories shared by the cell menu (set), the grid (colored marker), and the sidebar
// (counts). The `id` is what persists in the workspace db's `tags` table; never rename an id
// without a migration. Colors use Tailwind palette utilities (not citrus tokens) because tag
// severity is semantic, not part of the brand theme.

import { TAG_IDS, TAG_LABELS, type TagId } from '../../../shared/tags'

export type { TagId }
export { TAG_IDS, TAG_LABELS, isTagId } from '../../../shared/tags'

export interface TagDef {
  id: TagId
  label: string
  /** Left-edge marker bar in the grid (+ dark variant). */
  bar: string
  /** Small swatch in menus / legends (+ dark variant). */
  dot: string
  /** Faint full-row background tint so tagged rows are spottable when scrolled far right. */
  row: string
}

/** Colours per tag, keyed by TagId. Typed as a full Record, so adding a tag to the SHARED vocabulary
 *  without giving it a colour here is a compile error rather than an untinted row discovered later. */
const TAG_COLORS: Record<TagId, Omit<TagDef, 'id' | 'label'>> = {
  malicious: { bar: 'bg-red-500 dark:bg-red-400', dot: 'bg-red-500 dark:bg-red-400', row: 'bg-red-500/10 dark:bg-red-500/20' },
  suspicious: { bar: 'bg-amber-500 dark:bg-amber-400', dot: 'bg-amber-500 dark:bg-amber-400', row: 'bg-amber-400/10 dark:bg-amber-400/15' },
  unknown: { bar: 'bg-slate-400 dark:bg-slate-400', dot: 'bg-slate-400 dark:bg-slate-400', row: 'bg-slate-400/10 dark:bg-slate-400/15' },
  benign: { bar: 'bg-emerald-500 dark:bg-emerald-400', dot: 'bg-emerald-500 dark:bg-emerald-400', row: 'bg-emerald-500/10 dark:bg-emerald-500/15' }
}

/** Built FROM the shared vocabulary, so ids and order can't diverge from what the agent may apply. */
export const TAG_DEFS: TagDef[] = TAG_IDS.map((id) => ({ id, label: TAG_LABELS[id], ...TAG_COLORS[id] }))

const BY_ID: Record<string, TagDef> = Object.fromEntries(TAG_DEFS.map((t) => [t.id, t]))

export function tagDef(id: string | undefined): TagDef | undefined {
  return id ? BY_ID[id] : undefined
}
