import { describe, expect, it } from 'vitest'
import { classifyIndicator } from './classify'

describe('classifyIndicator', () => {
  it('classifies IPv4', () => {
    expect(classifyIndicator('8.8.8.8')).toBe('ipv4')
    expect(classifyIndicator('  45.9.1.2 ')).toBe('ipv4') // trims
  })

  it('classifies hashes by length', () => {
    expect(classifyIndicator('d41d8cd98f00b204e9800998ecf8427e')).toBe('md5')
    expect(classifyIndicator('da39a3ee5e6b4b0d3255bfef95601890afd80709')).toBe('sha1')
    expect(classifyIndicator('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')).toBe('sha256')
  })

  it('classifies URLs, emails, and domains', () => {
    expect(classifyIndicator('https://evil.example.com/path')).toBe('url')
    expect(classifyIndicator('attacker@evil.com')).toBe('email')
    expect(classifyIndicator('evil.example.com')).toBe('domain')
  })

  it('returns null for non-indicators', () => {
    expect(classifyIndicator('')).toBeNull()
    expect(classifyIndicator('hello world')).toBeNull()
    expect(classifyIndicator('999.999.999.999')).toBeNull() // not a valid octet
  })

  it('does not match a substring — the whole value must be the indicator', () => {
    expect(classifyIndicator('go to 8.8.8.8 now')).toBeNull()
  })
})
