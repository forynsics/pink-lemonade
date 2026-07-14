import { describe, expect, it } from 'vitest'
import { privateIpReason } from './ipranges'

describe('privateIpReason', () => {
  it('flags the RFC1918 private ranges', () => {
    expect(privateIpReason('10.17.42.9')).toMatch(/Private/)
    expect(privateIpReason('172.19.5.20')).toMatch(/Private/)
    expect(privateIpReason('172.28.130.6')).toMatch(/Private/)
    expect(privateIpReason('192.168.44.9')).toMatch(/Private/)
  })

  it('flags loopback / link-local / CGNAT / multicast / reserved', () => {
    expect(privateIpReason('127.0.0.1')).toMatch(/Loopback/)
    expect(privateIpReason('169.254.1.2')).toMatch(/Link-local/)
    expect(privateIpReason('100.64.0.1')).toMatch(/Carrier-grade NAT/)
    expect(privateIpReason('239.255.255.250')).toMatch(/Multicast/)
    expect(privateIpReason('255.255.255.255')).toMatch(/Broadcast/)
  })

  it('does NOT flag public IPs', () => {
    expect(privateIpReason('11.22.33.44')).toBeNull()
    expect(privateIpReason('12.34.56.78')).toBeNull()
    expect(privateIpReason('23.45.67.89')).toBeNull()
    expect(privateIpReason('172.32.0.1')).toBeNull() // just outside 172.16/12
    expect(privateIpReason('88.77.66.55')).toBeNull()
  })

  it('handles IPv6 special ranges', () => {
    expect(privateIpReason('::1')).toMatch(/Loopback/)
    expect(privateIpReason('fe80::1')).toMatch(/Link-local/)
    expect(privateIpReason('fd00::1')).toMatch(/Unique-local/)
    expect(privateIpReason('2001:db8::5c3a')).toBeNull() // public
  })

  it('returns null for non-IPs', () => {
    expect(privateIpReason('not-an-ip')).toBeNull()
    expect(privateIpReason('999.1.1.1')).toBeNull()
  })
})
