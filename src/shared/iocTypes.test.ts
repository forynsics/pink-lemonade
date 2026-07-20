import { describe, it, expect } from 'vitest'
import { IOC_TYPES, IOC_SYNONYMS, TYPE_ORDER, ENRICHABLE, normalizeIocType } from './iocTypes'

describe('IOC taxonomy', () => {
  // TYPE_ORDER is derived from IOC_TYPES rather than written out again — the panel's section order
  // and its labels cannot disagree, which is the whole reason this vocabulary is shared.
  it('derives the panel order from the labels', () => {
    expect(TYPE_ORDER).toEqual(Object.keys(IOC_TYPES))
  })

  it('resolves every synonym to a real type', () => {
    for (const [alias, target] of Object.entries(IOC_SYNONYMS)) {
      expect(Object.keys(IOC_TYPES), `synonym "${alias}" points at unknown type "${target}"`).toContain(target)
    }
  })

  it('only offers enrichment for types that exist', () => {
    for (const id of ENRICHABLE) expect(Object.keys(IOC_TYPES)).toContain(id)
  })
})

describe('account IOC type', () => {
  // The compromised account is the thread tying an intrusion's hosts together. With no type for it,
  // it was filed under `process`, which misleads anyone reading the IOC list.
  it('is a first-class type', () => {
    expect(IOC_TYPES.account).toBe('Account')
    expect(normalizeIocType('account')).toBe('account')
  })

  it('accepts the ways a model actually names one', () => {
    for (const s of ['user', 'username', 'user name', 'User_Account', 'samAccountName', 'UPN', 'login', 'SID', 'credential'])
      expect(normalizeIocType(s), `"${s}" should map to account`).toBe('account')
  })

  it('does not swallow neighbouring concepts', () => {
    expect(normalizeIocType('email')).toBe('email')
    expect(normalizeIocType('cloud')).toBe('cloud')
    expect(normalizeIocType('nonsense')).toBeNull()
  })

  // A victim hostname is a subject of the case, not an indicator to hunt or share — it belongs to the
  // planned Systems entity, so these keep meaning "the DNS name of something".
  it('leaves host/hostname meaning domain', () => {
    expect(normalizeIocType('hostname')).toBe('domain')
    expect(normalizeIocType('host')).toBe('domain')
  })
})
