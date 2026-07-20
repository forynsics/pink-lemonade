// The row-tag vocabulary — the SINGLE definition of which intent tags exist, read by both the AI
// toolbox (main) and the grid/menus (renderer).
//
// The `id` is what persists in the workspace db's `tags` table; NEVER rename one without a migration.
// This was previously duplicated, held together only by a comment saying "MUST match the renderer's
// TagId" — if they drifted, the agent would tag rows with an id the grid cannot render, and the tag
// would be stored but invisible.
//
// Presentation deliberately stays in the renderer (`state/tags.ts`): tag COLOURS are a UI concern and
// would drag Tailwind classes into the main process. Only the vocabulary lives here.

export type TagId = 'malicious' | 'suspicious' | 'unknown' | 'benign'

/** Every tag id, in severity order. The renderer renders in this order; the toolbox validates against it. */
export const TAG_IDS: readonly TagId[] = ['malicious', 'suspicious', 'unknown', 'benign'] as const

/** Display label for each id — the same word the analyst sees in the grid and the agent uses in prose. */
export const TAG_LABELS: Record<TagId, string> = {
  malicious: 'Malicious',
  suspicious: 'Suspicious',
  unknown: 'Unknown',
  benign: 'Benign'
}

/** Is this a real tag id? */
export function isTagId(v: unknown): v is TagId {
  return typeof v === 'string' && (TAG_IDS as readonly string[]).includes(v)
}
