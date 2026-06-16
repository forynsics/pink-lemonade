import { describe, it, expect } from 'vitest'
import { parseIntelText } from './sweepIntel'

describe('parseIntelText — classification + feedback', () => {
  it('accepts IPs, domains, and hashes with the right kind', () => {
    const { entries, counts } = parseIntelText('8.8.8.8\nevil.com\nd41d8cd98f00b204e9800998ecf8427e')
    expect(entries).toEqual([
      { value: '8.8.8.8', kind: 'ipv4' },
      { value: 'evil.com', kind: 'domain' },
      { value: 'd41d8cd98f00b204e9800998ecf8427e', kind: 'hash' }
    ])
    expect(counts).toEqual({ ipv4: 1, domain: 1, hash: 1, skipped: 0 })
  })

  it('reduces a URL to its domain (with a note)', () => {
    const { lines, entries } = parseIntelText('https://mail.evil.com/path?x=1')
    expect(entries).toEqual([{ value: 'mail.evil.com', kind: 'domain' }])
    expect(lines[0]).toMatchObject({ status: 'ok', kind: 'domain', value: 'mail.evil.com', note: 'from URL' })
  })

  it('refangs a defanged value (with a note)', () => {
    const { lines, entries } = parseIntelText('8[.]8[.]8[.]8')
    expect(entries).toEqual([{ value: '8.8.8.8', kind: 'ipv4' }])
    expect(lines[0]).toMatchObject({ status: 'ok', kind: 'ipv4', note: 'refanged' })
  })

  it('skips an incomplete IP with a reason', () => {
    const { lines, counts } = parseIntelText('8.8.8')
    expect(lines[0]).toMatchObject({ status: 'skip' })
    expect(counts.skipped).toBe(1)
  })

  it('skips gibberish and ignores blank lines', () => {
    const { lines, counts, entries } = parseIntelText('not an ioc\n\n   \nevil.com')
    expect(entries).toEqual([{ value: 'evil.com', kind: 'domain' }])
    expect(counts.skipped).toBe(1) // 'not an ioc'; blanks are ignored, not skipped
    expect(lines).toHaveLength(2) // gibberish + the domain
  })

  it('dedupes case-insensitively', () => {
    const { entries } = parseIntelText('Evil.com\nevil.com\nEVIL.COM')
    expect(entries).toEqual([{ value: 'Evil.com', kind: 'domain' }])
  })
})
