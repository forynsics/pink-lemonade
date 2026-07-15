import { describe, expect, it } from 'vitest'
import { ATTACK_VERSION, resolveTechnique } from './attack'
import catalog from './attackCatalog.json'

describe('resolveTechnique', () => {
  it('canonicalizes a known technique id (adds name + tactics)', () => {
    const r = resolveTechnique('T1059.001')
    expect(r).toMatchObject({ id: 'T1059.001', name: 'PowerShell', tactics: ['Execution'], verified: true })
    expect(r?.display).toBe('T1059.001 — PowerShell (Execution)')
  })

  it('extracts the id from an "id — name" string and canonicalizes it', () => {
    const r = resolveTechnique('T1059.001 - some loose name the model wrote')
    expect(r).toMatchObject({ id: 'T1059.001', name: 'PowerShell', verified: true })
  })

  it('resolves a technique by NAME to its id', () => {
    const r = resolveTechnique('Registry Run Keys / Startup Folder')
    expect(r).toMatchObject({ id: 'T1547.001', verified: true })
    expect(r?.tactics).toContain('Persistence')
  })

  it('keeps a valid-format but uncatalogued id, flagged unverified (does not drop it)', () => {
    const r = resolveTechnique('T1999.123')
    expect(r).toMatchObject({ id: 'T1999.123', verified: false, tactics: [] })
    expect(r?.display).toContain('(unverified)')
  })

  it('keeps an unrecognized free-text technique, flagged unverified', () => {
    const r = resolveTechnique('definitely not a technique')
    expect(r).toMatchObject({ id: null, verified: false })
    expect(r?.display).toContain('(unverified)')
  })

  it('returns null for empty input', () => {
    expect(resolveTechnique('')).toBeNull()
  })

  it('is case-insensitive on ids', () => {
    expect(resolveTechnique('t1003.001')?.id).toBe('T1003.001')
  })
})

// ATT&CK renumbers techniques between releases. A model trained on an older version still cites the
// old id, so these are the cases that would otherwise be wrongly flagged unverified.
describe('resolveTechnique — retired ids', () => {
  it('upgrades a retired id to its replacement and records what was cited', () => {
    const r = resolveTechnique('T1562.001')
    expect(r).toMatchObject({ id: 'T1685', name: 'Disable or Modify Tools', verified: true, supersededFrom: 'T1562.001' })
    expect(r?.display).toBe('T1685 — Disable or Modify Tools (Defense Impairment)')
  })

  it('follows a multi-hop replacement chain to a live technique', () => {
    // T1150 -> T1547.011 -> T1647; only the last is live.
    expect(resolveTechnique('T1150')?.id).toBe('T1647')
  })

  it('upgrades the id even when the model wrote a name alongside it', () => {
    expect(resolveTechnique('T1562.001 — Disable or Modify Tools')?.id).toBe('T1685')
  })

  it('leaves supersededFrom unset for an id that was already current', () => {
    expect(resolveTechnique('T1059.001')?.supersededFrom).toBeUndefined()
  })
})

describe('resolveTechnique — multi-tactic techniques', () => {
  it('reports every tactic, not just one', () => {
    const r = resolveTechnique('T1078')
    expect(r?.name).toBe('Valid Accounts')
    expect(r?.tactics.length).toBeGreaterThan(1)
    expect(r?.tactics).toEqual(expect.arrayContaining(['Initial Access', 'Persistence', 'Privilege Escalation']))
    expect(r?.display).toContain('Initial Access')
    expect(r?.display).toContain('Persistence')
  })
})

describe('resolveTechnique — name matching', () => {
  it('prefers the most specific name when several are present in the input', () => {
    expect(resolveTechnique('Spearphishing Attachment')?.id).toBe('T1566.001')
  })

  it('still resolves the parent when only the parent name is given', () => {
    expect(resolveTechnique('Phishing')?.id).toBe('T1566')
  })

  it('does not fuzzy-match a short generic word against 697 techniques', () => {
    expect(resolveTechnique('Data')?.verified).toBe(false)
  })

  it('is deterministic — the same input always resolves the same way', () => {
    const ids = Array.from({ length: 5 }, () => resolveTechnique('credential dumping from lsass memory')?.id)
    expect(new Set(ids).size).toBe(1)
  })
})

describe('attackCatalog.json', () => {
  it('carries the full live Enterprise technique set', () => {
    expect(catalog.techniques.length).toBeGreaterThan(600)
    expect(ATTACK_VERSION).toMatch(/^\d+\.\d+$/)
  })

  it('has no duplicate ids', () => {
    const ids = catalog.techniques.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('gives every technique an id, a name, and at least one tactic', () => {
    for (const t of catalog.techniques) {
      expect(t.id).toMatch(/^T\d{4}(\.\d{3})?$/)
      expect(t.name.length).toBeGreaterThan(0)
      expect(t.tactics.length).toBeGreaterThan(0)
    }
  })

  it('maps every retired id to a live technique, and never to itself', () => {
    const live = new Set(catalog.techniques.map((t) => t.id))
    for (const [from, to] of Object.entries(catalog.superseded)) {
      expect(from).not.toBe(to)
      expect(live.has(to)).toBe(true)
      expect(live.has(from)).toBe(false)
    }
  })
})
