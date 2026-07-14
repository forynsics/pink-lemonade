import { describe, expect, it } from 'vitest'
import { classifyIndicator } from './classify'

describe('classifyIndicator', () => {
  it('classifies IPv4', () => {
    expect(classifyIndicator('192.0.2.55')).toBe('ipv4')
    expect(classifyIndicator('  203.0.113.88 ')).toBe('ipv4') // trims
  })

  it('classifies hashes by length', () => {
    expect(classifyIndicator('a3f19c72e0b84d6519fca02e77b3d148')).toBe('md5')
    expect(classifyIndicator('b7e4c1a90f2d63e85a17c04fb9d21e6a3c8f5074')).toBe('sha1')
    expect(classifyIndicator('9f2c1a7e0b45d38c6ea19f470b2d85c3a6f01e94d7b28c5f3a0e6d19b74c2f85')).toBe('sha256')
  })

  it('classifies URLs, emails, and domains', () => {
    expect(classifyIndicator('https://node.example.com/path')).toBe('url')
    expect(classifyIndicator('user7@example.com')).toBe('email')
    expect(classifyIndicator('node.example.com')).toBe('domain')
  })

  it('returns null for non-indicators', () => {
    expect(classifyIndicator('')).toBeNull()
    expect(classifyIndicator('hello world')).toBeNull()
    expect(classifyIndicator('999.999.999.999')).toBeNull() // not a valid octet
  })

  it('does not match a substring — the whole value must be the indicator', () => {
    expect(classifyIndicator('go to 192.0.2.55 now')).toBeNull()
  })
})
