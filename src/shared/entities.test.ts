import { describe, it, expect } from 'vitest'
import {
  ENTITY_KINDS,
  ENTITY_STATUSES,
  ENTITY_STATUS_LABELS,
  AGENT_SETTABLE_STATUSES,
  aliasSuggestion,
  entityId,
  isEntityKind,
  isEntityStatus,
  normalizeEntityValue
} from './entities'

describe('entity vocabulary', () => {
  it('has the two kinds the panel renders', () => {
    expect(ENTITY_KINDS).toEqual(['system', 'account'])
  })

  // Mirrors the row-tag vocabulary so the same words mean the same thing across rows and entities.
  it('mirrors the tag verdicts', () => {
    expect(ENTITY_STATUSES).toEqual(['compromised', 'suspected', 'cleared', 'unknown'])
    for (const s of ENTITY_STATUSES) expect(ENTITY_STATUS_LABELS[s]).toBeTruthy()
  })

  // Same rule as the Benign tag: declaring something clean is the analyst's determination.
  it('does not let an agent clear an entity', () => {
    expect(AGENT_SETTABLE_STATUSES).not.toContain('cleared')
    expect(AGENT_SETTABLE_STATUSES).toContain('compromised')
  })

  it('validates kinds and statuses', () => {
    expect(isEntityKind('system')).toBe(true)
    expect(isEntityKind('Host')).toBe(false)
    expect(isEntityStatus('cleared')).toBe(true)
    expect(isEntityStatus('benign')).toBe(false)
  })
})

describe('normalizeEntityValue / entityId', () => {
  // Case-fold ONLY. Anything more would silently merge entities, which is the one thing the identity
  // rule must never do.
  it('folds case and trims, nothing else', () => {
    expect(normalizeEntityValue('  HOST-A ')).toBe('host-a')
    expect(normalizeEntityValue('EXAMPLE\\Admin')).toBe('example\\admin')
    expect(normalizeEntityValue('host.example.test')).toBe('host.example.test')
  })

  it('does NOT merge a domain-qualified account with a bare one', () => {
    expect(entityId('account', 'EXAMPLE\\admin')).not.toBe(entityId('account', 'admin'))
  })

  it('does NOT merge an FQDN with its short name', () => {
    expect(entityId('system', 'host.example.test')).not.toBe(entityId('system', 'host'))
  })

  it('treats case variants as one entity', () => {
    expect(entityId('system', 'HOST-A')).toBe(entityId('system', 'host-a'))
  })

  it('keeps kinds in separate namespaces', () => {
    expect(entityId('system', 'admin')).not.toBe(entityId('account', 'admin'))
  })
})

describe('aliasSuggestion', () => {
  it('proposes a domain-qualified account and its bare name', () => {
    const s = aliasSuggestion('account', 'EXAMPLE\\svc_account', 'svc_account')
    expect(s).toMatch(/svc_account/)
    expect(s).toMatch(/different domains\?/)
  })

  it('proposes a UPN and its bare name', () => {
    expect(aliasSuggestion('account', 'svc_account@example.test', 'svc_account')).toBeTruthy()
  })

  it('proposes an FQDN and its short host name', () => {
    expect(aliasSuggestion('system', 'host-a.example.test', 'HOST-A')).toMatch(/same system/)
  })

  it('says nothing for values that are already the same', () => {
    expect(aliasSuggestion('system', 'HOST-A', 'host-a')).toBeNull()
  })

  it('says nothing for genuinely different names', () => {
    expect(aliasSuggestion('account', 'alice', 'bob')).toBeNull()
    expect(aliasSuggestion('system', 'host-a', 'host-b')).toBeNull()
  })

  // An IP is not a hostname with a domain suffix — splitting on the first dot would make
  // 192.0.2.15 and "192" the same host.
  it('does not treat an IP address as a short name plus a domain', () => {
    expect(aliasSuggestion('system', '192.0.2.15', '192')).toBeNull()
  })

  // The suggestion is a CLAIM someone has to confirm, so it must be reviewable rather than silent.
  it('explains why it is proposing the link', () => {
    expect(aliasSuggestion('account', 'EXAMPLE\\svc', 'OTHER\\svc')).toMatch(/same principal, or different domains/)
  })
})
