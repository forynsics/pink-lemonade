import { describe, expect, it } from 'vitest'
import { classifyIndicator } from './classify'

describe('classifyIndicator (main-side)', () => {
  it('classifies hashes by length', () => {
    expect(classifyIndicator('7d4e9a1f2c6b8035e91d4a7c2f6b90e3')).toBe('md5')
    expect(classifyIndicator('3b8f1d6a2e9c4750b1a8f3d62c7e04915a9b2d8f')).toBe('sha1')
    expect(classifyIndicator('c2f7a91d0e6b4835f1a72c9d0e5b8346a1f9c72d0b6e4835c1a90f7d2e6b4835')).toBe('sha256')
  })

  it('classifies IPv4', () => {
    expect(classifyIndicator('203.0.113.7')).toBe('ipv4')
    expect(classifyIndicator('192.168.14.203')).toBe('ipv4')
  })

  it('classifies IPv6 (the branch the renderer classifier lacks)', () => {
    expect(classifyIndicator('2001:db8::1')).toBe('ipv6')
    expect(classifyIndicator('fe80::1')).toBe('ipv6')
    expect(classifyIndicator('::1')).toBe('ipv6')
  })

  it('classifies urls, emails, and domains (broadest last)', () => {
    expect(classifyIndicator('https://evil.example.com/path')).toBe('url')
    expect(classifyIndicator('user@example.com')).toBe('email')
    expect(classifyIndicator('bad.sub.example.com')).toBe('domain')
  })

  it('returns null for unrecognized input', () => {
    expect(classifyIndicator('')).toBeNull()
    expect(classifyIndicator('not an indicator')).toBeNull()
    expect(classifyIndicator('   ')).toBeNull()
  })

  it('anchors the whole string (no partial matches)', () => {
    // A domain embedded in a sentence must not classify as a domain.
    expect(classifyIndicator('see evil.example.com now')).toBeNull()
  })
})
