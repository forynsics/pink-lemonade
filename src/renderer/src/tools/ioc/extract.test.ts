import { describe, expect, it } from 'vitest'
import { getById } from '../registry'
import './extract'

const BLOB = `
Contact user5@node.example from 203.0.113.47 and 10.17.42.8 (internal).
Defanged: hxxp://198[.]51[.]100[.]23/payload and mal[.]sample[.]test
SHA256: 4e1d9a07c3b62f58e0a91d4c7b035f8a2e6c19d70b4a83f5c1e0d29a6b78f34c
MD5: c8d4e2f1907a6b35de0c14f829a7b3d6 — also a duplicate hit on 203.0.113.47
`

const run = (id: string, opts = {}): string[] =>
  getById(id)!
    .run(BLOB, opts)
    .split('\n')
    .filter(Boolean)

describe('ioc extractors', () => {
  it('extracts public IPv4, refangs, dedups, and excludes private by default', () => {
    const ips = run('ioc.extract.ipv4')
    expect(ips).toContain('203.0.113.47')
    expect(ips).toContain('198.51.100.23') // refanged from 198[.]51[.]100[.]23
    expect(ips).not.toContain('10.17.42.8') // private excluded
    expect(ips.filter((i) => i === '203.0.113.47')).toHaveLength(1) // unique
  })

  it('includes private IPs when asked', () => {
    expect(run('ioc.extract.ipv4', { includePrivate: true })).toContain('10.17.42.8')
  })

  it('extracts hashes by exact length', () => {
    expect(run('ioc.extract.sha256')).toEqual([
      '4e1d9a07c3b62f58e0a91d4c7b035f8a2e6c19d70b4a83f5c1e0d29a6b78f34c'
    ])
    expect(run('ioc.extract.md5')).toEqual(['c8d4e2f1907a6b35de0c14f829a7b3d6'])
  })

  it('extracts emails', () => {
    expect(run('ioc.extract.email')).toContain('user5@node.example')
  })
})
