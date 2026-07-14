// Pure source resolution for the AI toolbox: map a model-supplied `source` reference (a name, a
// numeric id, or nothing) to one of the workspace's sources. Electron-free so it can be unit-tested.

import type { WsCtx, WsSource } from './types'

/** A source's path-style identity: "Group/name" (the group is its folder), or just the name when
 *  ungrouped. Groups make identical filenames across hosts addressable like files in folders. */
export function pathOf(s: WsSource): string {
  return s.group ? `${s.group}/${s.name}` : s.name
}

/** The source a tool should act on, resolved from a model-supplied reference. Resolution order:
 *  (1) empty → the on-screen/only source; (2) a numeric source id (absolute); (3) a group-qualified
 *  path "Group/name"; (4) an exact name; (5) a unique substring. Because multiple groups legitimately
 *  share identical filenames (every host's "hayabusa_events_offline.csv"), an exact name that matches
 *  MORE THAN ONE source is a hard error listing the path candidates — never a silent pick of the first
 *  (which would return another host's data). The agent then addresses it by its "Group/name" path. */
export function resolveSource(ws: WsCtx, ref?: unknown): WsSource {
  const sources = ws.sources ?? []
  if (!ws.hasWorkspace || sources.length === 0) {
    throw new Error('No workspace is open. Open a workspace and import a file first.')
  }

  const raw = ref == null ? '' : String(ref).trim()
  if (raw === '') {
    // No explicit source → the one on screen, or the only one, or the first.
    const active = sources.find((s) => s.sourceId === ws.activeSourceId)
    return active ?? sources[0]
  }

  // A numeric reference is a source id — the absolute, never-ambiguous handle.
  if (/^\d+$/.test(raw)) {
    const byId = sources.find((s) => s.sourceId === Number(raw))
    if (byId) return byId
  }

  // A group-qualified path "Group/name" (folders-and-files) — resolve by (group, name).
  const slash = raw.indexOf('/')
  if (slash > 0) {
    const g = raw.slice(0, slash).trim().toLowerCase()
    const n = raw.slice(slash + 1).trim().toLowerCase()
    const byPath = sources.filter((s) => (s.group ?? '').toLowerCase() === g && s.name.toLowerCase() === n)
    if (byPath.length === 1) return byPath[0]
    if (byPath.length > 1) {
      throw new Error(`"${raw}" still matches ${byPath.length} sources — target one by numeric id: ${byPath.map((s) => `${s.sourceId} (${pathOf(s)})`).join(', ')}.`)
    }
    // Path didn't resolve — fall through to name handling for a helpful error.
  }

  const lc = raw.toLowerCase()
  const exact = sources.filter((s) => s.name.toLowerCase() === lc)
  if (exact.length === 1) return exact[0]
  if (exact.length > 1) {
    // Identical filename across groups — the collision case. Make the analyst/agent pick the folder.
    throw new Error(
      `"${raw}" is ambiguous — ${exact.length} sources share that name across groups: ${exact.map((s) => `${pathOf(s)} (id ${s.sourceId})`).join(', ')}. ` +
        `Target it by its group path (e.g. "${pathOf(exact[0])}") or numeric id.`
    )
  }

  // Fall back to a unique substring match (e.g. "amcache" → "Amcache_UnassociatedFileEntries.csv").
  const partial = sources.filter((s) => s.name.toLowerCase().includes(lc))
  if (partial.length === 1) return partial[0]
  if (partial.length > 1) {
    throw new Error(`"${raw}" matches multiple sources (${partial.map((s) => pathOf(s)).join(', ')}). Be more specific — use a group path "Group/name" or a numeric id.`)
  }
  throw new Error(`No source matches "${raw}". Available sources: ${sources.map((s) => pathOf(s)).join(', ')}.`)
}
