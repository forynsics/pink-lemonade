import { describe, it, expect } from 'vitest'
import { compileIntel, matchText, type IntelEntry } from './sweep'

/** Compile a set and return the matched values for a cell (kind-tagged), for compact assertions. */
function sweep(cell: string, entries: IntelEntry[]): string[] {
  return matchText(cell, compileIntel(entries)).map((h) => `${h.kind}:${h.value}`)
}

describe('matchText — ipv4 (whole token)', () => {
  const ip: IntelEntry[] = [{ value: '8.8.8.8', kind: 'ipv4' }]

  it('matches an IP embedded in surrounding text', () => {
    expect(sweep('explorer.exe connected to 8.8.8.8', ip)).toEqual(['ipv4:8.8.8.8'])
  })

  it('matches with trailing sentence punctuation', () => {
    expect(sweep('blocked 8.8.8.8.', ip)).toEqual(['ipv4:8.8.8.8'])
  })

  it('does NOT match inside a longer dotted number', () => {
    expect(sweep('18.8.8.81', ip)).toEqual([])
    expect(sweep('8.8.8.80', ip)).toEqual([])
    expect(sweep('108.8.8.8', ip)).toEqual([])
  })
})

describe('matchText — hash (whole token, length-independent)', () => {
  const md5 = 'd41d8cd98f00b204e9800998ecf8427e'
  const entries: IntelEntry[] = [{ value: md5, kind: 'hash' }]

  it('matches a hash delimited by non-hex', () => {
    expect(sweep(`hash=${md5} (cached)`, entries)).toEqual([`hash:${md5}`])
  })

  it('does NOT match when the hex run is longer (a different hash)', () => {
    expect(sweep(`${md5}ab`, entries)).toEqual([])
  })
})

describe('matchText — filename (whole token)', () => {
  const fn: IntelEntry[] = [{ value: 'svchost.exe', kind: 'filename' }]

  it('matches a filename inside a path', () => {
    expect(sweep('C:\\Windows\\System32\\svchost.exe', fn)).toEqual(['filename:svchost.exe'])
  })

  it('does NOT match a filename glued to other name chars', () => {
    expect(sweep('notsvchost.exe', fn)).toEqual([])
  })
})

describe('matchText — domain (substring, subdomain-friendly)', () => {
  const dom: IntelEntry[] = [{ value: 'evil.com', kind: 'domain' }]

  it('matches the bare domain and its subdomains', () => {
    expect(sweep('GET http://mail.evil.com/path', dom)).toEqual(['domain:evil.com'])
    expect(sweep('evil.com', dom)).toEqual(['domain:evil.com'])
  })
})

describe('matchText — case-insensitivity (paramount)', () => {
  it('matches regardless of case on either side, for every kind', () => {
    const entries: IntelEntry[] = [
      { value: 'EVIL.COM', kind: 'domain' },
      { value: 'MimiKatz.EXE', kind: 'filename' },
      { value: 'D41D8CD98F00B204E9800998ECF8427E', kind: 'hash' }
    ]
    expect(sweep('connect mail.evil.com', entries)).toContain('domain:EVIL.COM')
    expect(sweep('ran C:\\tmp\\mimikatz.exe now', entries)).toContain('filename:MimiKatz.EXE')
    expect(sweep('sha d41d8cd98f00b204e9800998ecf8427e', entries)).toContain(
      'hash:D41D8CD98F00B204E9800998ECF8427E'
    )
  })
})

describe('matchText — multiple hits + compile', () => {
  it('returns every distinct indicator found in one cell', () => {
    const entries: IntelEntry[] = [
      { value: '8.8.8.8', kind: 'ipv4' },
      { value: 'evil.com', kind: 'domain' },
      { value: 'mimikatz.exe', kind: 'filename' }
    ]
    const hits = sweep('mimikatz.exe on host beaconed to evil.com via 8.8.8.8', entries)
    expect(hits.sort()).toEqual(['domain:evil.com', 'filename:mimikatz.exe', 'ipv4:8.8.8.8'])
  })

  it('dedupes the intel set case-insensitively (one hit, not two)', () => {
    const entries: IntelEntry[] = [
      { value: 'Evil.com', kind: 'domain' },
      { value: 'evil.com', kind: 'domain' }
    ]
    expect(sweep('evil.com', entries)).toHaveLength(1)
  })

  it('returns nothing for an empty cell', () => {
    expect(sweep('', [{ value: '8.8.8.8', kind: 'ipv4' }])).toEqual([])
  })
})
