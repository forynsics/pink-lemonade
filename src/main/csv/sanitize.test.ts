import { describe, it, expect } from 'vitest'
import { sanitizeHeaders, detectDelimiter } from './sanitize'

describe('sanitizeHeaders', () => {
  it('maps to positional c0..cN and trims originals', () => {
    expect(sanitizeHeaders([' source.ip ', 'Country'])).toEqual([
      { name: 'c0', original: 'source.ip' },
      { name: 'c1', original: 'Country' }
    ])
  })

  it('fills empty headers with a positional label', () => {
    expect(sanitizeHeaders(['', '  '])).toEqual([
      { name: 'c0', original: 'Column 1' },
      { name: 'c1', original: 'Column 2' }
    ])
  })

  it('de-duplicates display names while keeping safe ids distinct', () => {
    expect(sanitizeHeaders(['ip', 'ip', 'ip'])).toEqual([
      { name: 'c0', original: 'ip' },
      { name: 'c1', original: 'ip (2)' },
      { name: 'c2', original: 'ip (3)' }
    ])
  })

  it('uses positional ids regardless of SQL-keyword headers', () => {
    const cols = sanitizeHeaders(['select', 'drop table'])
    expect(cols.map((c) => c.name)).toEqual(['c0', 'c1'])
  })
})

describe('detectDelimiter', () => {
  it('detects comma / tab / pipe / semicolon by frequency', () => {
    expect(detectDelimiter('a,b,c')).toBe(',')
    expect(detectDelimiter('a\tb\tc')).toBe('\t')
    expect(detectDelimiter('a|b|c')).toBe('|')
    expect(detectDelimiter('a;b;c')).toBe(';')
  })

  it('picks the most frequent when mixed', () => {
    expect(detectDelimiter('a,b;c;d;e')).toBe(';')
  })

  it('defaults to comma when no delimiter present', () => {
    expect(detectDelimiter('single')).toBe(',')
  })
})
