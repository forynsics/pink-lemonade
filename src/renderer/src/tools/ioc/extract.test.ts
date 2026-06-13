import { describe, expect, it } from 'vitest'
import { getById } from '../registry'
import './extract'

const BLOB = `
Contact evil@bad.example from 8.8.8.8 and 10.0.0.5 (internal).
Defanged: hxxp://1[.]2[.]3[.]4/payload and bad[.]domain[.]com
SHA256: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
MD5: d41d8cd98f00b204e9800998ecf8427e — also a duplicate hit on 8.8.8.8
`

const run = (id: string, opts = {}): string[] =>
  getById(id)!
    .run(BLOB, opts)
    .split('\n')
    .filter(Boolean)

describe('ioc extractors', () => {
  it('extracts public IPv4, refangs, dedups, and excludes private by default', () => {
    const ips = run('ioc.extract.ipv4')
    expect(ips).toContain('8.8.8.8')
    expect(ips).toContain('1.2.3.4') // refanged from 1[.]2[.]3[.]4
    expect(ips).not.toContain('10.0.0.5') // private excluded
    expect(ips.filter((i) => i === '8.8.8.8')).toHaveLength(1) // unique
  })

  it('includes private IPs when asked', () => {
    expect(run('ioc.extract.ipv4', { includePrivate: true })).toContain('10.0.0.5')
  })

  it('extracts hashes by exact length', () => {
    expect(run('ioc.extract.sha256')).toEqual([
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    ])
    expect(run('ioc.extract.md5')).toEqual(['d41d8cd98f00b204e9800998ecf8427e'])
  })

  it('extracts emails', () => {
    expect(run('ioc.extract.email')).toContain('evil@bad.example')
  })
})
