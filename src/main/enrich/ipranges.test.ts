import { describe, expect, it } from 'vitest'
import { privateIpReason } from './ipranges'

describe('privateIpReason', () => {
  it('flags the RFC1918 private ranges', () => {
    expect(privateIpReason('10.0.0.5')).toMatch(/Private/)
    expect(privateIpReason('172.16.4.4')).toMatch(/Private/)
    expect(privateIpReason('172.31.255.1')).toMatch(/Private/)
    expect(privateIpReason('192.168.1.1')).toMatch(/Private/)
  })

  it('flags loopback / link-local / CGNAT / multicast / reserved', () => {
    expect(privateIpReason('127.0.0.1')).toMatch(/Loopback/)
    expect(privateIpReason('169.254.1.2')).toMatch(/Link-local/)
    expect(privateIpReason('100.64.0.1')).toMatch(/Carrier-grade NAT/)
    expect(privateIpReason('239.255.255.250')).toMatch(/Multicast/)
    expect(privateIpReason('255.255.255.255')).toMatch(/Broadcast/)
  })

  it('does NOT flag public IPs', () => {
    expect(privateIpReason('8.8.8.8')).toBeNull()
    expect(privateIpReason('45.9.148.99')).toBeNull()
    expect(privateIpReason('1.1.1.1')).toBeNull()
    expect(privateIpReason('172.32.0.1')).toBeNull() // just outside 172.16/12
    expect(privateIpReason('11.0.0.1')).toBeNull()
  })

  it('handles IPv6 special ranges', () => {
    expect(privateIpReason('::1')).toMatch(/Loopback/)
    expect(privateIpReason('fe80::1')).toMatch(/Link-local/)
    expect(privateIpReason('fd00::1')).toMatch(/Unique-local/)
    expect(privateIpReason('2606:4700::1111')).toBeNull() // public (Cloudflare)
  })

  it('returns null for non-IPs', () => {
    expect(privateIpReason('not-an-ip')).toBeNull()
    expect(privateIpReason('999.1.1.1')).toBeNull()
  })
})
