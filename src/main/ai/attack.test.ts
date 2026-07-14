import { describe, expect, it } from 'vitest'
import { resolveTechnique } from './attack'

describe('resolveTechnique', () => {
  it('canonicalizes a known technique id (adds name + tactic)', () => {
    const r = resolveTechnique('T1562.001')
    expect(r).toMatchObject({ id: 'T1562.001', name: 'Disable or Modify Tools', tactic: 'Defense Evasion', verified: true })
    expect(r?.display).toBe('T1562.001 — Disable or Modify Tools (Defense Evasion)')
  })

  it('extracts the id from an "id — name" string and canonicalizes it', () => {
    const r = resolveTechnique('T1059.001 - some loose name the model wrote')
    expect(r).toMatchObject({ id: 'T1059.001', name: 'PowerShell', verified: true })
  })

  it('resolves a technique by NAME to its id', () => {
    const r = resolveTechnique('Registry Run Keys / Startup Folder')
    expect(r).toMatchObject({ id: 'T1547.001', verified: true, tactic: 'Persistence' })
  })

  it('keeps a valid-format but uncatalogued id, flagged unverified (does not drop it)', () => {
    const r = resolveTechnique('T1999.123')
    expect(r).toMatchObject({ id: 'T1999.123', verified: false })
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
