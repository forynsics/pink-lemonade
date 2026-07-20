import { describe, it, expect } from 'vitest'
import { DerivedEntity, StoredEntity, mergeEntities, uncollectedSystems } from './entityDerive'

const src = (value: string): DerivedEntity => ({ kind: 'system', value, collected: true, eventCount: 0 })
const seen = (kind: 'system' | 'account', value: string, n = 1): DerivedEntity => ({
  kind,
  value,
  collected: false,
  eventCount: n
})

const store = (p: Partial<StoredEntity> & Pick<StoredEntity, 'id' | 'kind' | 'name'>): StoredEntity => ({
  origin: 'asserted',
  status: 'unknown',
  role: null,
  notes: null,
  actor: 'analyst',
  createdAt: 1700000000,
  updatedAt: 1700000000,
  ...p
})

describe('mergeEntities — the derived spine', () => {
  it('treats a source group as an evidenced, collected system', () => {
    const [e] = mergeEntities([src('HOST-A')], [])
    expect(e).toMatchObject({ kind: 'system', name: 'HOST-A', origin: 'evidenced', collected: true, evidenced: true })
  })

  // The whole point of the model: named in the data, never collected.
  it('treats an entity seen only in an event as evidenced but NOT collected', () => {
    const [e] = mergeEntities([seen('system', 'HOST-Z')], [])
    expect(e).toMatchObject({ evidenced: true, collected: false })
  })

  it('unions the facts when one entity is both a source group and in events', () => {
    const out = mergeEntities([src('HOST-A'), seen('system', 'host-a', 3)], [])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ collected: true, eventCount: 3 })
  })

  it('sums event counts across separate sightings', () => {
    const out = mergeEntities([seen('account', 'svc', 2), seen('account', 'svc', 5)], [])
    expect(out[0].eventCount).toBe(7)
  })

  it('keeps systems and accounts of the same name apart', () => {
    expect(mergeEntities([seen('system', 'admin'), seen('account', 'admin')], [])).toHaveLength(2)
  })

  it('ignores a blank value rather than minting an empty entity', () => {
    expect(mergeEntities([seen('system', '   ')], [])).toEqual([])
  })

  it('defaults an unjudged entity to unknown', () => {
    expect(mergeEntities([src('HOST-A')], [])[0].status).toBe('unknown')
  })
})

describe('mergeEntities — the curated overlay', () => {
  it('applies status, role and notes to a derived entity', () => {
    const out = mergeEntities(
      [src('HOST-A')],
      [store({ id: 'system:host-a', kind: 'system', name: 'HOST-A', status: 'compromised', role: 'File server' })]
    )
    expect(out[0]).toMatchObject({ status: 'compromised', role: 'File server', collected: true })
  })

  it('keeps an entity nobody has evidenced as asserted', () => {
    const out = mergeEntities([], [store({ id: 'system:host-q', kind: 'system', name: 'HOST-Q' })])
    expect(out[0]).toMatchObject({ origin: 'asserted', evidenced: false, collected: false })
  })

  // The promotion path — an assertion becomes evidenced when the data catches up to it, with nobody
  // editing the record.
  it('promotes an asserted entity once the data names it', () => {
    const out = mergeEntities([seen('system', 'HOST-Q')], [store({ id: 'system:host-q', kind: 'system', name: 'HOST-Q' })])
    expect(out[0]).toMatchObject({ origin: 'evidenced', evidenced: true })
  })

  it('promotes an asserted entity that cited grounding', () => {
    const out = mergeEntities([], [store({ id: 'system:host-q', kind: 'system', name: 'HOST-Q', groundingCount: 2 })])
    expect(out[0]).toMatchObject({ origin: 'evidenced', evidenced: true })
  })

  // Curation must never be able to claim we hold data we do not hold.
  it('does not let a stored record fake collection', () => {
    const out = mergeEntities([], [store({ id: 'system:host-q', kind: 'system', name: 'HOST-Q', origin: 'evidenced' })])
    expect(out[0].collected).toBe(false)
  })

  it('lets a curated name fix the display casing', () => {
    const out = mergeEntities([src('host-a')], [store({ id: 'system:host-a', kind: 'system', name: 'HOST-A' })])
    expect(out[0].name).toBe('HOST-A')
  })

  it('falls back to the observed name when the record has none', () => {
    const out = mergeEntities([src('HOST-A')], [store({ id: 'system:host-a', kind: 'system', name: '' })])
    expect(out[0].name).toBe('HOST-A')
  })

  it('carries aliases and grounding count through', () => {
    const out = mergeEntities(
      [src('HOST-A')],
      [store({ id: 'system:host-a', kind: 'system', name: 'HOST-A', aliases: ['host-a.example.test'], groundingCount: 3 })]
    )
    expect(out[0]).toMatchObject({ aliases: ['host-a.example.test'], groundingCount: 3 })
  })

  it('repairs an unrecognized stored status instead of trusting it', () => {
    const bad = store({ id: 'system:host-a', kind: 'system', name: 'HOST-A', status: 'benign' as never })
    expect(mergeEntities([src('HOST-A')], [bad])[0].status).toBe('unknown')
  })
})

describe('mergeEntities — authorship', () => {
  // The panel badges the author instead of the old "asserted" word, so a derived entity must carry
  // NO actor — there is nobody to name, and inventing one would misattribute the case's own data.
  it('leaves a derived entity with no author', () => {
    expect(mergeEntities([src('HOST-A')], [])[0].actor).toBeNull()
  })

  it('reports who added a curated entity', () => {
    const out = mergeEntities([], [store({ id: 'system:host-q', kind: 'system', name: 'HOST-Q', actor: 'ai' })])
    expect(out[0].actor).toBe('ai')
  })

  // The SQL enforces the write-side half of this rule (an AI upsert can't overwrite an analyst's
  // display name); this pins the read side — whatever name is stored is what gets shown.
  it('shows the stored name over the observed one regardless of author', () => {
    const out = mergeEntities([src('host-a')], [store({ id: 'system:host-a', kind: 'system', name: 'HOST-A', actor: 'analyst' })])
    expect(out[0].name).toBe('HOST-A')
  })

  it('keeps the author when the data later evidences the entity', () => {
    const out = mergeEntities([seen('system', 'HOST-Q')], [store({ id: 'system:host-q', kind: 'system', name: 'HOST-Q', actor: 'ai' })])
    expect(out[0]).toMatchObject({ origin: 'evidenced', actor: 'ai' })
  })
})

describe('mergeEntities — ordering', () => {
  it('puts systems before accounts, then the most-involved first', () => {
    const out = mergeEntities([seen('account', 'alice', 9), seen('system', 'HOST-B', 1), seen('system', 'HOST-A', 4)], [])
    expect(out.map((e) => e.name)).toEqual(['HOST-A', 'HOST-B', 'alice'])
  })
})

describe('mergeEntities — collected resolution', () => {
  // THE bug this fix exists for: a run recorded hosts by FQDN while the packages were grouped by
  // short name, so the case's own hosts were reported as collection gaps.
  it('treats an FQDN as collected when its short name is a source group', () => {
    const out = mergeEntities(
      [src('HOST-A')],
      [store({ id: 'system:host-a.example.test', kind: 'system', name: 'host-a.example.test' })]
    )
    const fq = out.find((e) => e.name === 'host-a.example.test')
    expect(fq).toMatchObject({ collected: true, collectedVia: 'shortName' })
  })

  it('marks a real source group as collected via the group itself, not an inference', () => {
    expect(mergeEntities([src('HOST-A')], [])[0].collectedVia).toBe('group')
  })

  it('resolves collection through a confirmed alias', () => {
    const out = mergeEntities(
      [src('HOST-A')],
      [store({ id: 'system:10.0.0.5', kind: 'system', name: '10.0.0.5', aliases: ['HOST-A'] })]
    )
    expect(out.find((e) => e.name === '10.0.0.5')).toMatchObject({ collected: true, collectedVia: 'alias' })
  })

  // Grounding is a MENTION, not possession — inferring collection from it would manufacture data
  // we don't have out of a log line that merely names an address.
  it('does not treat grounding as collection', () => {
    const out = mergeEntities(
      [src('HOST-A')],
      [store({ id: 'system:10.0.0.5', kind: 'system', name: '10.0.0.5', groundingCount: 9 })]
    )
    expect(out.find((e) => e.name === '10.0.0.5')).toMatchObject({ collected: false, collectedVia: null })
  })

  it('leaves a genuinely uncollected host uncollected', () => {
    const out = mergeEntities([src('HOST-A')], [store({ id: 'system:host-q', kind: 'system', name: 'HOST-Q' })])
    expect(out.find((e) => e.name === 'HOST-Q')).toMatchObject({ collected: false, collectedVia: null })
  })

  // An account is never "collected" — the concept doesn't apply, and pretending it does is what
  // trained an agent to ignore the field entirely.
  it('never resolves collection for an account', () => {
    const out = mergeEntities([src('HOST-A')], [store({ id: 'account:host-a', kind: 'account', name: 'host-a' })])
    expect(out.find((e) => e.kind === 'account')).toMatchObject({ collected: false })
  })
})

describe('uncollectedSystems', () => {
  it('no longer reports the case’s own hosts, recorded by FQDN, as gaps', () => {
    const out = mergeEntities(
      [src('HOST-A'), src('HOST-B')],
      [
        store({ id: 'system:host-a.example.test', kind: 'system', name: 'host-a.example.test' }),
        store({ id: 'system:host-q', kind: 'system', name: 'HOST-Q' })
      ]
    )
    expect(uncollectedSystems(out).map((e) => e.name)).toEqual(['HOST-Q'])
  })

  // The one output an analyst acts on directly: it is a collection request.
  it('names the systems whose data is missing, and never an account', () => {
    const out = mergeEntities([src('HOST-A'), seen('system', 'HOST-Z', 2), seen('account', 'svc', 4)], [])
    expect(uncollectedSystems(out).map((e) => e.name)).toEqual(['HOST-Z'])
  })

  // An agent that notices a host referenced in the data often records it WITHOUT citing grounding.
  // Gating this list on evidence hid exactly those — the failure the whole model exists to prevent.
  it('includes an ASSERTED system, not just evidenced ones', () => {
    const out = mergeEntities([src('HOST-A')], [store({ id: 'system:host-q', kind: 'system', name: 'HOST-Q' })])
    const gaps = uncollectedSystems(out)
    expect(gaps.map((e) => e.name)).toEqual(['HOST-Q'])
    expect(gaps[0].origin).toBe('asserted')
  })

  it('excludes a system we actually collected', () => {
    expect(uncollectedSystems(mergeEntities([src('HOST-A')], []))).toEqual([])
  })
})
