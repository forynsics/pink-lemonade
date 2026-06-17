import { describe, it, expect } from 'vitest'
import { deriveVerdict, sumStats, curateFields, deriveTier, normalizeIndicator } from './vtShared'

describe('deriveVerdict', () => {
  it('is Clean when nothing flags', () => {
    expect(deriveVerdict({ malicious: 0, suspicious: 0 })).toBe('Clean')
    expect(deriveVerdict(undefined)).toBe('Clean')
    expect(deriveVerdict({})).toBe('Clean')
  })
  it('is Suspicious for a single malicious or any suspicious (below threshold)', () => {
    expect(deriveVerdict({ malicious: 1, suspicious: 0 })).toBe('Suspicious')
    expect(deriveVerdict({ malicious: 0, suspicious: 1 })).toBe('Suspicious')
    expect(deriveVerdict({ malicious: 0, suspicious: 9 })).toBe('Suspicious')
  })
  it('is Malicious at/above the threshold of 2', () => {
    expect(deriveVerdict({ malicious: 2, suspicious: 0 })).toBe('Malicious')
    expect(deriveVerdict({ malicious: 3, suspicious: 5 })).toBe('Malicious')
  })
  it('respects a custom threshold', () => {
    expect(deriveVerdict({ malicious: 2 }, 3)).toBe('Suspicious')
    expect(deriveVerdict({ malicious: 3 }, 3)).toBe('Malicious')
  })
})

describe('sumStats', () => {
  it('sums all numeric buckets (IP/domain shape)', () => {
    expect(sumStats({ malicious: 2, suspicious: 1, harmless: 60, undetected: 10, timeout: 0 })).toBe(73)
  })
  it('includes the extra buckets files carry', () => {
    expect(
      sumStats({ malicious: 5, suspicious: 0, harmless: 0, undetected: 50, 'type-unsupported': 8, 'confirmed-timeout': 1, failure: 2 })
    ).toBe(66)
  })
  it('is 0 (no throw) for missing/garbage stats', () => {
    expect(sumStats(undefined)).toBe(0)
    expect(sumStats({} as never)).toBe(0)
    expect(sumStats({ malicious: NaN, suspicious: undefined } as never)).toBe(0)
  })
})

describe('normalizeIndicator', () => {
  it('lowercases hashes only', () => {
    expect(normalizeIndicator('ABCDEF', 'md5')).toBe('abcdef')
    expect(normalizeIndicator('DeadBeef', 'sha1')).toBe('deadbeef')
    expect(normalizeIndicator('AABB', 'sha256')).toBe('aabb')
  })
  it('leaves IPs and domains untouched', () => {
    expect(normalizeIndicator('8.8.8.8', 'ipv4')).toBe('8.8.8.8')
    expect(normalizeIndicator('Example.COM', 'domain')).toBe('Example.COM')
  })
})

describe('curateFields', () => {
  it('maps IP attributes and computes verdict/total/link', () => {
    const f = curateFields('ipv4', '1.2.3.4', {
      last_analysis_stats: { malicious: 3, suspicious: 1, harmless: 50, undetected: 20 },
      reputation: -7,
      as_owner: 'EXAMPLE-AS',
      asn: 64500,
      country: 'US',
      network: '1.2.3.0/24'
    })
    expect(f['VT Verdict']).toBe('Malicious')
    expect(f['VT Malicious']).toBe('3')
    expect(f['VT Suspicious']).toBe('1')
    expect(f['VT Total']).toBe('74')
    expect(f.Reputation).toBe('-7')
    expect(f['AS Owner']).toBe('EXAMPLE-AS')
    expect(f.ASN).toBe('AS64500')
    expect(f.Country).toBe('US')
    expect(f.Network).toBe('1.2.3.0/24')
    expect(f['VT Link']).toBe('https://www.virustotal.com/gui/ip-address/1.2.3.4')
  })

  it('maps domain attributes incl. joined categories and creation date', () => {
    const f = curateFields('domain', 'example.com', {
      last_analysis_stats: { malicious: 0, suspicious: 0, harmless: 80 },
      registrar: 'Example Registrar',
      categories: { engineA: 'phishing', engineB: 'phishing', engineC: 'malware' },
      creation_date: 1000000000
    })
    expect(f['VT Verdict']).toBe('Clean')
    expect(f.Registrar).toBe('Example Registrar')
    expect(f.Categories).toBe('phishing, malware') // de-duped
    expect(f.Created).toBe('2001-09-09')
    expect(f['VT Link']).toBe('https://www.virustotal.com/gui/domain/example.com')
  })

  it('maps file attributes', () => {
    const f = curateFields('sha256', 'abc123', {
      last_analysis_stats: { malicious: 40, suspicious: 0, undetected: 20, 'type-unsupported': 3 },
      meaningful_name: 'evil.exe',
      type_description: 'Win32 EXE',
      size: 102400
    })
    expect(f['VT Verdict']).toBe('Malicious')
    expect(f['VT Total']).toBe('63')
    expect(f.Name).toBe('evil.exe')
    expect(f.Type).toBe('Win32 EXE')
    expect(f.Size).toBe('102400')
    expect(f['VT Link']).toBe('https://www.virustotal.com/gui/file/abc123')
  })

  it('is defensive against missing fields (no throw, sane defaults)', () => {
    const f = curateFields('ipv4', '9.9.9.9', {})
    expect(f['VT Verdict']).toBe('Clean')
    expect(f['VT Malicious']).toBe('0')
    expect(f['VT Total']).toBe('0')
    expect(f.Reputation).toBeUndefined()
    expect(f['AS Owner']).toBeUndefined()
    expect(f['VT Link']).toBe('https://www.virustotal.com/gui/ip-address/9.9.9.9')
  })
})

describe('deriveTier', () => {
  it('detects free tier (≤500/day) → paced at 4/min', () => {
    expect(deriveTier({ quotas: { api_requests_daily: { allowed: 500, used: 10 } } })).toEqual({
      tier: 'free',
      dailyQuota: 500,
      requestsPerMinute: 4
    })
  })
  it('detects premium (higher quota) → unthrottled', () => {
    expect(deriveTier({ quotas: { api_requests_daily: { allowed: 1000000 } } })).toEqual({
      tier: 'premium',
      dailyQuota: 1000000,
      requestsPerMinute: 0
    })
  })
  it('falls back to a safe free-tier default when the shape is unknown', () => {
    expect(deriveTier(undefined)).toEqual({ tier: 'free', dailyQuota: null, requestsPerMinute: 4 })
    expect(deriveTier({})).toEqual({ tier: 'free', dailyQuota: null, requestsPerMinute: 4 })
  })
})
