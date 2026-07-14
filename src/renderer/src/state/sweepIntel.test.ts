import { describe, it, expect } from 'vitest'
import { parseIntelText } from './sweepIntel'

describe('parseIntelText — classification + feedback', () => {
  it('accepts IPs, domains, and hashes with the right kind', () => {
    const { entries, counts } = parseIntelText('192.0.2.5\nphish.example\na3f5c1029b7e4d6488fa0c2e51db9370')
    expect(entries).toEqual([
      { value: '192.0.2.5', kind: 'ipv4' },
      { value: 'phish.example', kind: 'domain' },
      { value: 'a3f5c1029b7e4d6488fa0c2e51db9370', kind: 'hash' }
    ])
    expect(counts).toEqual({ ipv4: 1, domain: 1, hash: 1, filename: 0, skipped: 0 })
  })

  it('reduces a URL to its domain (with a note)', () => {
    const { lines, entries } = parseIntelText('https://mail.phish.example/path?x=1')
    expect(entries).toEqual([{ value: 'mail.phish.example', kind: 'domain' }])
    expect(lines[0]).toMatchObject({ status: 'ok', kind: 'domain', value: 'mail.phish.example', note: 'from URL' })
  })

  it('refangs a defanged value (with a note)', () => {
    const { lines, entries } = parseIntelText('192[.]0[.]2[.]55')
    expect(entries).toEqual([{ value: '192.0.2.55', kind: 'ipv4' }])
    expect(lines[0]).toMatchObject({ status: 'ok', kind: 'ipv4', note: 'refanged' })
  })

  it('skips an incomplete IP with a reason', () => {
    const { lines, counts } = parseIntelText('192.0.2')
    expect(lines[0]).toMatchObject({ status: 'skip' })
    expect(counts.skipped).toBe(1)
  })

  it('skips gibberish and ignores blank lines', () => {
    const { lines, counts, entries } = parseIntelText('not an ioc\n\n   \nphish.example')
    expect(entries).toEqual([{ value: 'phish.example', kind: 'domain' }])
    expect(counts.skipped).toBe(1) // 'not an ioc'; blanks are ignored, not skipped
    expect(lines).toHaveLength(2) // gibberish + the domain
  })

  it('dedupes case-insensitively', () => {
    const { entries } = parseIntelText('Sample.example\nsample.example\nSAMPLE.EXAMPLE')
    expect(entries).toEqual([{ value: 'Sample.example', kind: 'domain' }])
  })

  it('does NOT auto-classify a filename in classify mode (evil.exe reads as a domain)', () => {
    const { entries } = parseIntelText('evil.exe')
    // The classifier can't tell evil.exe from a domain — this is why filename is declared-only.
    expect(entries).toEqual([{ value: 'evil.exe', kind: 'domain' }])
  })
})

describe('parseIntelText — declared filename mode', () => {
  it('treats each line as a file name, taking the basename of a path', () => {
    const { entries } = parseIntelText('svchost.exe\nC:\\Windows\\System32\\evil.dll', 'filename')
    expect(entries).toEqual([
      { value: 'svchost.exe', kind: 'filename' },
      { value: 'evil.dll', kind: 'filename' }
    ])
  })

  it('skips a line that is not a single file-name token', () => {
    const { lines, counts } = parseIntelText('not a filename', 'filename')
    expect(lines[0]).toMatchObject({ status: 'skip' })
    expect(counts.skipped).toBe(1)
  })
})
