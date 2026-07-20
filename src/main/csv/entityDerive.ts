// The DERIVED SPINE of the entity model: what the case already knows about systems and accounts,
// before anyone curates anything.
//
// Two facts are already in the workspace and must never be hand-maintained:
//   - every source's `group_label` is a system whose data we HAVE (the host that produced the triage
//     package), so it is both evidenced and collected;
//   - every `event_entities` value is an entity some recorded event INVOLVES, which makes it evidenced
//     — but says nothing about whether we hold its data.
//
// That second case is the whole reason this model exists. A host named in a logon on another machine
// is evidenced and NOT collected, and until now that fact survived only in prose.
//
// Curated records (status, role, notes, and asserted entities nobody has evidenced yet) live in the
// `entities` table and are OVERLAID here. Derivation is re-run on every read rather than cached: the
// spine is a pure function of sources and events, so a cache could only ever be wrong.

import { EntityActor, EntityKind, EntityOrigin, EntityStatus, bareEntityName, entityId, isEntityStatus } from '../../shared/entities'

/** One entity observed in the case's own data. */
export interface DerivedEntity {
  kind: EntityKind
  /** Display form as first seen — normalization is for the id, never for what we show. */
  value: string
  /** True only for a system that produced a source. Nothing else proves we hold an entity's data. */
  collected: boolean
  /** How many recorded events involve it. 0 for a system known only from a source group. */
  eventCount: number
}

/** A curated record from the `entities` table. */
export interface StoredEntity {
  id: string
  kind: EntityKind
  name: string
  origin: EntityOrigin
  status: EntityStatus
  role: string | null
  notes: string | null
  createdAt: number
  updatedAt: number
  /** Who put this record here. Null for rows written before authorship was tracked. */
  actor: EntityActor | null
  aliases?: string[]
  groundingCount?: number
}

export interface EntityOut {
  id: string
  kind: EntityKind
  /** Display name. A curated record's name wins — the analyst may have fixed the casing. */
  name: string
  origin: EntityOrigin
  status: EntityStatus
  role: string | null
  notes: string | null
  /** Do we hold this entity's data? Derived, never stored — a stored copy could drift from the truth. */
  collected: boolean
  /** Events involving it. */
  eventCount: number
  /** True when it produced a source or appears in an event: i.e. the case itself vouches for it. */
  evidenced: boolean
  aliases: string[]
  groundingCount: number
  /**
   * Who added it: the AI agent, the analyst, or nobody (it came straight out of the data).
   *
   * This replaced an `asserted` badge in the UI. "Asserted" described the epistemics correctly but
   * read as jargon; what an analyst actually wants to know about an entry the data doesn't back is
   * WHO put it there, which is what tells them how much to trust it.
   */
  actor: EntityActor | null
  /**
   * HOW we concluded we hold its data — so a short-name inference is never mistaken for a fact.
   *
   *   'group'     the entity IS a source group; certain.
   *   'shortName' its short name matches a collected group (host-a.example.test → HOST-A). An
   *               inference: two domains could share a short host name.
   *   'alias'     a confirmed alias of it is a collected group.
   */
  collectedVia: 'group' | 'shortName' | 'alias' | null
  createdAt: number | null
  updatedAt: number | null
}

/**
 * Merge the derived spine with curated records into what the panel and the agent both read.
 *
 * The rules that matter:
 *  - `origin` is EVIDENCE-LED. A record stored as `asserted` becomes `evidenced` the moment the data
 *    backs it, without anyone editing it — that IS the promotion path. It never silently goes the
 *    other way: a stored `evidenced` record whose grounding was cited explicitly stays evidenced.
 *  - `collected` is derived only. Curation cannot claim we hold data we do not hold.
 *  - a curated `name` wins over the observed one, so fixing display casing sticks.
 */
export function mergeEntities(derived: DerivedEntity[], stored: StoredEntity[]): EntityOut[] {
  const out = new Map<string, EntityOut>()

  // Every SHORT name we actually hold a triage package for. An FQDN or a confirmed alias resolves
  // against this — see resolveCollected for why that inference is worth making.
  const collectedShort = new Set<string>()
  for (const d of derived) {
    if (d.collected) collectedShort.add(bareEntityName(d.kind, d.value))
  }

  for (const d of derived) {
    const id = entityId(d.kind, d.value)
    if (!id.endsWith(':')) {
      const prev = out.get(id)
      if (prev) {
        // Same entity seen twice (a source group AND an event, or two events): union the facts.
        prev.collected = prev.collected || d.collected
        prev.eventCount += d.eventCount
      } else {
        out.set(id, {
          id,
          kind: d.kind,
          name: d.value,
          origin: 'evidenced',
          status: 'unknown',
          role: null,
          notes: null,
          collected: d.collected,
          eventCount: d.eventCount,
          evidenced: true,
          aliases: [],
          groundingCount: 0,
          actor: null,
          collectedVia: d.collected ? 'group' : null,
          createdAt: null,
          updatedAt: null
        })
      }
    }
  }

  for (const s of stored) {
    const existing = out.get(s.id)
    const grounded = (s.groundingCount ?? 0) > 0
    const merged: EntityOut = {
      id: s.id,
      kind: s.kind,
      name: s.name || existing?.name || '',
      // Evidence-led: the data speaking for it, or cited grounding, outranks the stored flag.
      origin: existing || grounded || s.origin === 'evidenced' ? 'evidenced' : 'asserted',
      status: isEntityStatus(s.status) ? s.status : 'unknown',
      role: s.role,
      notes: s.notes,
      collected: existing?.collected ?? false,
      eventCount: existing?.eventCount ?? 0,
      evidenced: Boolean(existing) || grounded,
      aliases: s.aliases ?? [],
      groundingCount: s.groundingCount ?? 0,
      actor: s.actor,
      collectedVia: existing?.collectedVia ?? null,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt
    }
    out.set(s.id, merged)
  }

  // Resolve `collected` for entities that are not themselves a source group.
  //
  // This is the fix for the worst bug the model has had: a scoping run recorded its hosts by FQDN
  // (`host-a.example.test`) while the triage packages were grouped by short name (`HOST-A`), so the
  // three machines the entire case was built from were reported as COLLECTION GAPS — 15 reported
  // against 6 real ones, burying the real requests in noise about hosts already in the case.
  //
  // The short-name match is an INFERENCE (two domains could share a host name), and it is recorded as
  // one via collectedVia rather than presented as fact. Making it is clearly right: the cost of being
  // wrong is a missing collection request, while the cost of NOT making it was telling an analyst to
  // go collect three hosts already sitting in front of them.
  //
  // Note what is deliberately NOT here: grounding does not imply collection. Rows about `10.0.0.5` in
  // HOST-A's logs prove that address APPEARS in HOST-A's data, not that we hold that machine's disk.
  // Making that leap would manufacture collection out of a mention. Where the two really are the same
  // machine, the analyst or agent says so with link_entities, and the 'alias' path below picks it up.
  for (const e of out.values()) {
    if (e.collected || e.kind !== 'system') continue
    if (collectedShort.has(bareEntityName(e.kind, e.name))) {
      e.collected = true
      e.collectedVia = 'shortName'
      continue
    }
    if (e.aliases.some((a) => collectedShort.has(bareEntityName(e.kind, a)))) {
      e.collected = true
      e.collectedVia = 'alias'
    }
  }

  // Systems first, then the most-involved, then by name — so the panel opens on what matters.
  return [...out.values()].sort(
    (a, b) =>
      (a.kind === b.kind ? 0 : a.kind === 'system' ? -1 : 1) ||
      b.eventCount - a.eventCount ||
      a.name.localeCompare(b.name)
  )
}

/**
 * The gap worth surfacing: systems whose data we do not hold.
 *
 * This is the one output an analyst acts on directly — it's a collection request. A lateral-movement
 * run named six such hosts and called them the single biggest gap in the case.
 *
 * Deliberately NOT restricted to evidenced systems. A host only reaches this list because a source
 * produced it, an event involved it, or someone recorded it on purpose — and an agent that notices a
 * host referenced in the data will often record it WITHOUT citing grounding. Requiring evidence here
 * silently dropped exactly those, which is the failure this model was built to prevent. Origin still
 * rides along, so an asserted gap reads as less certain rather than being hidden.
 */
export function uncollectedSystems(entities: EntityOut[]): EntityOut[] {
  return entities.filter((e) => e.kind === 'system' && !e.collected)
}
