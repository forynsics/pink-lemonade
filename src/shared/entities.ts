// SYSTEMS and ACCOUNTS — the subjects of an investigation, as opposed to its indicators.
//
// An IOC is something you would hunt for or share; an ENTITY is a thing in THIS case that carries
// state: is it compromised, when was it first touched, do we even have its data. The same string can
// be both — `svc_account` is an account IOC you might hunt elsewhere AND the account this intrusion ran
// on — so entities link to IOCs rather than replacing them.
//
// Two INDEPENDENT axes, which is the point of the model:
//
//                    | collected (its data is in the case) | not collected
//   -----------------|-------------------------------------|---------------------------------
//   evidenced        | the ordinary case                   | "named in the data, never collected"
//   asserted         | rare                                | a hunch, or a scoping note
//
// The bottom-right and top-right cells are why this exists. A lateral-movement run found a payload
// pushed to six hosts with no triage packages — evidenced, uncollected, and the single most
// actionable output of the investigation — and there was nowhere to put them but prose.
//
// Anything may be ADDED (nothing is blocked), but an addition with nothing behind it lands as
// `asserted` and says so, the way record_lead keeps an unproven hypothesis visibly apart from a
// settled event. Searching the case for its name is what promotes it to `evidenced`.

export type EntityKind = 'system' | 'account'

export const ENTITY_KINDS: readonly EntityKind[] = ['system', 'account'] as const

export const ENTITY_KIND_LABELS: Record<EntityKind, { one: string; many: string }> = {
  system: { one: 'System', many: 'Systems' },
  account: { one: 'Account', many: 'Accounts' }
}

/** How we know this entity exists. Not a judgement about it — see EntityStatus for that. */
export type EntityOrigin = 'evidenced' | 'asserted'

/**
 * Who added a curated entity record.
 *
 * Surfaced in place of an "asserted" badge: the epistemic word was accurate but read as jargon, and
 * for an entry the data doesn't back, WHO put it there is the thing that tells an analyst how far to
 * trust it. An entity that came out of the data itself has no actor at all.
 */
export type EntityActor = 'ai' | 'analyst'

export function isEntityActor(v: unknown): v is EntityActor {
  return v === 'ai' || v === 'analyst'
}

/**
 * The analyst's verdict. Mirrors the row-tag vocabulary deliberately, so the same words carry the
 * same meaning across rows, tags and entities.
 *
 * `cleared` is the analyst's call ALONE — the same rule as the Benign tag. An agent may propose
 * compromised or suspected; declaring something clean is a human determination.
 */
export type EntityStatus = 'compromised' | 'suspected' | 'cleared' | 'unknown'

export const ENTITY_STATUSES: readonly EntityStatus[] = ['compromised', 'suspected', 'cleared', 'unknown'] as const

export const ENTITY_STATUS_LABELS: Record<EntityStatus, string> = {
  compromised: 'Compromised',
  suspected: 'Suspected',
  cleared: 'Cleared',
  unknown: 'Unknown'
}

/** Statuses an AI agent may set on its own. Clearing something is not one of them. */
export const AGENT_SETTABLE_STATUSES: readonly EntityStatus[] = ['compromised', 'suspected', 'unknown'] as const

export function isEntityKind(v: unknown): v is EntityKind {
  return typeof v === 'string' && (ENTITY_KINDS as readonly string[]).includes(v)
}

export function isEntityStatus(v: unknown): v is EntityStatus {
  return typeof v === 'string' && (ENTITY_STATUSES as readonly string[]).includes(v)
}

/**
 * The identity key for an entity — CASE-FOLD ONLY, deliberately.
 *
 * Nobody disputes that `HOST-A` and `host-a` are the same host, so folding case is safe. Everything beyond
 * that is a judgement call: stripping the domain would silently make `EXAMPLE\admin` and `OTHER\admin`
 * one principal, and merging two accounts wrongly corrupts the attribution the whole Timeline rests
 * on — invisibly, and long after the fact. So normalization never merges; `aliasSuggestion` proposes
 * links and a human or the agent confirms them.
 */
export function normalizeEntityValue(value: string): string {
  return String(value ?? '').trim().toLowerCase()
}

/** The stable id for an entity within a case. */
export function entityId(kind: EntityKind, value: string): string {
  return `${kind}:${normalizeEntityValue(value)}`
}

/**
 * Strip the parts that commonly decorate the same underlying name, for COMPARISON only.
 *
 * Exported because `collected` resolution needs it: a triage package is grouped as `HOST-A` while the
 * data calls the machine `host-a.example.test`, and reporting the case's OWN hosts as uncollected is
 * far worse than the small risk of two domains sharing a short host name. Comparison only — this is
 * never an id, so it can never merge two entities.
 */
export function bareEntityName(kind: EntityKind, value: string): string {
  return bareName(kind, value)
}

function bareName(kind: EntityKind, value: string): string {
  let v = normalizeEntityValue(value)
  if (kind === 'account') {
    const slash = v.lastIndexOf('\\')
    if (slash >= 0) v = v.slice(slash + 1) // DOMAIN\user → user
    const at = v.indexOf('@')
    if (at > 0) v = v.slice(0, at) // user@domain → user
  } else {
    const dot = v.indexOf('.')
    if (dot > 0 && !/^\d+$/.test(v.slice(0, dot))) v = v.slice(0, dot) // host.fqdn → host, but not an IP
  }
  return v
}

/**
 * Do these two look like the same entity? Used to SUGGEST a link, never to merge one.
 *
 * Returns null when they are already identical or clearly unrelated, and a reason when they are worth
 * proposing — the reason is shown to whoever confirms, because "these are the same" is a claim that
 * should be reviewable rather than silent.
 */
export function aliasSuggestion(kind: EntityKind, a: string, b: string): string | null {
  const na = normalizeEntityValue(a)
  const nb = normalizeEntityValue(b)
  if (!na || !nb || na === nb) return null
  const ba = bareName(kind, a)
  const bb = bareName(kind, b)
  if (ba !== bb || !ba) return null
  return kind === 'account'
    ? `"${a}" and "${b}" share the account name "${ba}" — same principal, or different domains?`
    : `"${a}" and "${b}" share the host name "${ba}" — same system, or a name collision?`
}
