// MITRE ATT&CK grounding for record_event. The full Enterprise technique set, generated from MITRE's
// official STIX data (`npm run build:attack` -> attackCatalog.json), so a technique the model cites is
// resolved to a canonical id + name + tactics instead of trusting its (often slightly-off) memory.
//
// Baked at build time rather than fetched at runtime: ATT&CK ships ~twice a year, we ship more often,
// and the 51 MB upstream bundle distills to ~57 KB. No network, no IPC, no settings.
//
// Soft/corrective by design:
//  - a known id/name is canonicalized;
//  - a RETIRED id is silently upgraded to its replacement (ATT&CK renumbers — T1562.001 is now T1685 —
//    and a model trained before the change still cites the old one);
//  - a valid-format id we don't carry is KEPT (flagged unverified), never dropped.

import catalog from './attackCatalog.json'

export interface AttackTechnique {
  id: string
  name: string
  /** Every tactic the technique belongs to — 145 of them have more than one. */
  tactics: string[]
}

const CATALOG: AttackTechnique[] = catalog.techniques
/** Retired id -> the current id that replaced it. */
const SUPERSEDED: Record<string, string> = catalog.superseded

/** The ATT&CK release this catalog was generated from (e.g. "19.1"). */
export const ATTACK_VERSION: string = catalog.version

const BY_ID = new Map(CATALOG.map((t) => [t.id, t]))
const ID_IN_TEXT = /T\d{4}(?:\.\d{3})?/i

// A name shorter than this is never fuzzy-matched. With the full 697-technique set, a generic
// short name would otherwise match a large slice of the corpus on a substring test.
const MIN_FUZZY = 5

export interface ResolvedTechnique {
  id: string | null
  name: string
  /** Every tactic for the technique; empty when unresolved. */
  tactics: string[]
  verified: boolean
  /** The retired id the model actually cited, when we upgraded it (e.g. 'T1562.001' -> T1685). */
  supersededFrom?: string
  /** One-line canonical form for storage/display. */
  display: string
}

function stripId(text: string): string {
  return text
    .replace(ID_IN_TEXT, '')
    .replace(/^[\s:—–-]+/, '')
    .replace(/[\s:—–-]+$/, '')
    .trim()
}

function resolved(t: AttackTechnique, supersededFrom?: string): ResolvedTechnique {
  const tactics = t.tactics.length ? ` (${t.tactics.join(', ')})` : ''
  return {
    id: t.id,
    name: t.name,
    tactics: t.tactics,
    verified: true,
    ...(supersededFrom ? { supersededFrom } : {}),
    display: `${t.id} — ${t.name}${tactics}`
  }
}

/** Best catalog entry for a free-text name. Exact wins; otherwise the LONGEST catalog name found in
 *  the input, so a sub-technique ("Spearphishing Attachment") beats its parent ("Phishing") rather
 *  than whichever happened to be first. Ties break on id, so the result is deterministic. */
function matchByName(lc: string): AttackTechnique | undefined {
  const exact = CATALOG.find((t) => t.name.toLowerCase() === lc)
  if (exact) return exact
  if (lc.length < MIN_FUZZY) return undefined

  const contained = CATALOG.filter((t) => t.name.length >= MIN_FUZZY && lc.includes(t.name.toLowerCase()))
  if (contained.length) return contained.sort((a, b) => b.name.length - a.name.length || (a.id < b.id ? -1 : 1))[0]

  // Nothing of ours sits inside the input — try the reverse (a partial/abbreviated name). The
  // SHORTEST containing name is the tightest fit, and a longer input makes a false hit unlikely.
  const containing = CATALOG.filter((t) => t.name.toLowerCase().includes(lc))
  if (containing.length) return containing.sort((a, b) => a.name.length - b.name.length || (a.id < b.id ? -1 : 1))[0]
  return undefined
}

/** Resolve a model-supplied technique (an id, "id — name", or a name) against the catalog. */
export function resolveTechnique(input: string): ResolvedTechnique | null {
  const raw = String(input ?? '').trim()
  if (!raw) return null

  const idMatch = raw.match(ID_IN_TEXT)
  if (idMatch) {
    const cited = idMatch[0].toUpperCase()
    // Upgrade a retired id before lookup, so a stale-but-real technique verifies instead of being
    // flagged unverified purely because the model learned ATT&CK at an older version.
    const current = SUPERSEDED[cited] ?? cited
    const hit = BY_ID.get(current)
    if (hit) return resolved(hit, current !== cited ? cited : undefined)
    const name = stripId(raw)
    return { id: cited, name: name || cited, tactics: [], verified: false, display: `${cited}${name ? ` — ${name}` : ''} (unverified)` }
  }

  const byName = matchByName(raw.toLowerCase())
  if (byName) return resolved(byName)
  return { id: null, name: raw, tactics: [], verified: false, display: `${raw} (unverified)` }
}
