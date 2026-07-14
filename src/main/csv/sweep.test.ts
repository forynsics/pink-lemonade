import { describe, it, expect } from 'vitest'
import { compileIntel, matchText, type IntelEntry } from './sweep'

/** Compile a set and return the matched values for a cell (kind-tagged), for compact assertions. */
function sweep(cell: string, entries: IntelEntry[]): string[] {
  return matchText(cell, compileIntel(entries)).map((h) => `${h.kind}:${h.value}`)
}

describe('matchText — ipv4 (whole token)', () => {
  const ip: IntelEntry[] = [{ value: '192.0.2.7', kind: 'ipv4' }]

  it('matches an IP embedded in surrounding text', () => {
    expect(sweep('explorer.exe connected to 192.0.2.7', ip)).toEqual(['ipv4:192.0.2.7'])
  })

  it('matches with trailing sentence punctuation', () => {
    expect(sweep('blocked 192.0.2.7.', ip)).toEqual(['ipv4:192.0.2.7'])
  })

  it('does NOT match inside a longer dotted number', () => {
    expect(sweep('5192.0.2.79', ip)).toEqual([])
    expect(sweep('192.0.2.70', ip)).toEqual([])
    expect(sweep('9192.0.2.7', ip)).toEqual([])
  })
})

describe('matchText — hash (whole token, length-independent)', () => {
  const md5 = 'a7f0c2e91b6d34805fa2c1e0d9b47e63'
  const entries: IntelEntry[] = [{ value: md5, kind: 'hash' }]

  it('matches a hash delimited by non-hex', () => {
    expect(sweep(`hash=${md5} (cached)`, entries)).toEqual([`hash:${md5}`])
  })

  it('does NOT match when the hex run is longer (a different hash)', () => {
    expect(sweep(`${md5}ab`, entries)).toEqual([])
  })
})

describe('matchText — filename (whole token)', () => {
  const fn: IntelEntry[] = [{ value: 'helper.exe', kind: 'filename' }]

  it('matches a filename inside a path', () => {
    expect(sweep('C:\\Windows\\System32\\helper.exe', fn)).toEqual(['filename:helper.exe'])
  })

  it('does NOT match a filename glued to other name chars', () => {
    expect(sweep('nothelper.exe', fn)).toEqual([])
  })
})

describe('matchText — domain (substring, subdomain-friendly)', () => {
  const dom: IntelEntry[] = [{ value: 'badsite.example', kind: 'domain' }]

  it('matches the bare domain and its subdomains', () => {
    expect(sweep('GET http://mail.badsite.example/path', dom)).toEqual(['domain:badsite.example'])
    expect(sweep('badsite.example', dom)).toEqual(['domain:badsite.example'])
  })
})

describe('matchText — case-insensitivity (paramount)', () => {
  it('matches regardless of case on either side, for every kind', () => {
    const entries: IntelEntry[] = [
      { value: 'BADSITE.EXAMPLE', kind: 'domain' },
      { value: 'PayLoad.EXE', kind: 'filename' },
      { value: 'A7F0C2E91B6D34805FA2C1E0D9B47E63', kind: 'hash' }
    ]
    expect(sweep('connect mail.badsite.example', entries)).toContain('domain:BADSITE.EXAMPLE')
    expect(sweep('ran C:\\tmp\\payload.exe now', entries)).toContain('filename:PayLoad.EXE')
    expect(sweep('sha a7f0c2e91b6d34805fa2c1e0d9b47e63', entries)).toContain(
      'hash:A7F0C2E91B6D34805FA2C1E0D9B47E63'
    )
  })
})

describe('matchText — multiple hits + compile', () => {
  it('returns every distinct indicator found in one cell', () => {
    const entries: IntelEntry[] = [
      { value: '192.0.2.7', kind: 'ipv4' },
      { value: 'badsite.example', kind: 'domain' },
      { value: 'payload.exe', kind: 'filename' }
    ]
    const hits = sweep('payload.exe on host beaconed to badsite.example via 192.0.2.7', entries)
    expect(hits.sort()).toEqual(['domain:badsite.example', 'filename:payload.exe', 'ipv4:192.0.2.7'])
  })

  it('dedupes the intel set case-insensitively (one hit, not two)', () => {
    const entries: IntelEntry[] = [
      { value: 'Badsite.example', kind: 'domain' },
      { value: 'badsite.example', kind: 'domain' }
    ]
    expect(sweep('badsite.example', entries)).toHaveLength(1)
  })

  it('returns nothing for an empty cell', () => {
    expect(sweep('', [{ value: '192.0.2.7', kind: 'ipv4' }])).toEqual([])
  })
})
