import { describe, it, expect } from 'vitest'
import {
  ipv4ToInt,
  parseIpEntry,
  normalizeAsn,
  normalizeDomain,
  normalizeHash,
  normalizeIpv6,
  normalizeEntry
} from './watchlistMatch'

describe('ipv4ToInt', () => {
  it('parses dotted quads to uint32', () => {
    expect(ipv4ToInt('0.0.0.0')).toBe(0)
    expect(ipv4ToInt('255.255.255.255')).toBe(4294967295)
    expect(ipv4ToInt('10.4.2.7')).toBe(10 * 2 ** 24 + 4 * 2 ** 16 + 2 * 256 + 7)
    expect(ipv4ToInt('192.168.0.1')).toBe(3232235521)
  })
  it('rejects junk', () => {
    expect(ipv4ToInt('256.0.0.1')).toBeNull()
    expect(ipv4ToInt('1.2.3')).toBeNull()
    expect(ipv4ToInt('a.b.c.d')).toBeNull()
    expect(ipv4ToInt('1.2.3.4.5')).toBeNull()
  })
})

describe('parseIpEntry (IPv4 + CIDR ranges)', () => {
  it('single IP → lo === hi', () => {
    expect(parseIpEntry('8.8.8.8')).toEqual({ lo: ipv4ToInt('8.8.8.8'), hi: ipv4ToInt('8.8.8.8') })
  })
  it('/24 spans 256 addresses, masking host bits', () => {
    const r = parseIpEntry('192.168.1.50/24')!
    expect(r.lo).toBe(ipv4ToInt('192.168.1.0'))
    expect(r.hi).toBe(ipv4ToInt('192.168.1.255'))
    expect(r.hi - r.lo).toBe(255)
  })
  it('/8 spans a full first octet', () => {
    const r = parseIpEntry('10.0.0.0/8')!
    expect(r.lo).toBe(ipv4ToInt('10.0.0.0'))
    expect(r.hi).toBe(ipv4ToInt('10.255.255.255'))
  })
  it('/0 is the whole space, /32 is a single host', () => {
    expect(parseIpEntry('0.0.0.0/0')).toEqual({ lo: 0, hi: 4294967295 })
    expect(parseIpEntry('1.2.3.4/32')).toEqual({ lo: ipv4ToInt('1.2.3.4'), hi: ipv4ToInt('1.2.3.4') })
  })
  it('contains its members', () => {
    const r = parseIpEntry('10.0.0.0/8')!
    const v = ipv4ToInt('10.4.2.7')!
    expect(v >= r.lo && v <= r.hi).toBe(true)
    expect(ipv4ToInt('11.0.0.1')! >= r.lo && ipv4ToInt('11.0.0.1')! <= r.hi).toBe(false)
  })
  it('rejects bad masks / junk', () => {
    expect(parseIpEntry('10.0.0.0/33')).toBeNull()
    expect(parseIpEntry('10.0.0.0/x')).toBeNull()
    expect(parseIpEntry('nope')).toBeNull()
  })
})

describe('normalizeAsn', () => {
  it('accepts AS-prefixed and bare numbers, dropping zero padding', () => {
    expect(normalizeAsn('AS15169')).toBe('15169')
    expect(normalizeAsn('as15169')).toBe('15169')
    expect(normalizeAsn('ASN 9009')).toBe('9009')
    expect(normalizeAsn('15169')).toBe('15169')
    expect(normalizeAsn('00042')).toBe('42')
  })
  it('rejects non-numeric', () => {
    expect(normalizeAsn('AS')).toBeNull()
    expect(normalizeAsn('comcast')).toBeNull()
    expect(normalizeAsn('')).toBeNull()
  })
})

describe('normalizeDomain', () => {
  it('lowercases and strips scheme/path/port', () => {
    expect(normalizeDomain('Evil.COM')).toBe('evil.com')
    expect(normalizeDomain('https://bad.example.org/path?x=1')).toBe('bad.example.org')
    expect(normalizeDomain('host.example.net:8080')).toBe('host.example.net')
    expect(normalizeDomain('trailing.dot.com.')).toBe('trailing.dot.com')
  })
  it('rejects non-domains', () => {
    expect(normalizeDomain('localhost')).toBeNull()
    expect(normalizeDomain('not a domain')).toBeNull()
    expect(normalizeDomain('')).toBeNull()
  })
})

describe('normalizeHash', () => {
  it('accepts md5/sha1/sha256 hex (any case)', () => {
    expect(normalizeHash('D41D8CD98F00B204E9800998ECF8427E')).toBe('d41d8cd98f00b204e9800998ecf8427e')
    expect(normalizeHash('a'.repeat(40))).toBe('a'.repeat(40))
    expect(normalizeHash('f'.repeat(64))).toBe('f'.repeat(64))
  })
  it('rejects wrong lengths / non-hex', () => {
    expect(normalizeHash('abc')).toBeNull()
    expect(normalizeHash('z'.repeat(32))).toBeNull()
  })
})

describe('normalizeIpv6', () => {
  it('lowercases and drops the zone id', () => {
    expect(normalizeIpv6('2001:DB8::1')).toBe('2001:db8::1')
    expect(normalizeIpv6('fe80::1%eth0')).toBe('fe80::1')
  })
  it('rejects non-v6', () => {
    expect(normalizeIpv6('10.0.0.1')).toBeNull()
  })
})

describe('normalizeEntry (dispatch by kind)', () => {
  it('ip: IPv4 → range, IPv6 → norm', () => {
    expect(normalizeEntry('ip', '10.0.0.0/8')).toEqual({ lo: ipv4ToInt('10.0.0.0'), hi: ipv4ToInt('10.255.255.255') })
    expect(normalizeEntry('ip', '2001:db8::1')).toEqual({ norm: '2001:db8::1' })
  })
  it('asn/domain/hash → norm; blanks and junk → null', () => {
    expect(normalizeEntry('asn', 'AS9009')).toEqual({ norm: '9009' })
    expect(normalizeEntry('domain', 'Bad.Example.com')).toEqual({ norm: 'bad.example.com' })
    expect(normalizeEntry('hash', 'A'.repeat(64))).toEqual({ norm: 'a'.repeat(64) })
    expect(normalizeEntry('ip', '   ')).toBeNull()
    expect(normalizeEntry('asn', 'nope')).toBeNull()
  })
})
