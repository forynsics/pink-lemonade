// Classifies non-routable / special-use IPs so the engine can skip enriching them — they have no
// meaningful geo/reputation, and (importantly) sending an internal address to a network provider
// like VirusTotal would leak it. Returns a short human reason, or null for a normal public IP.

function ipv4Reason(o: number[]): string | null {
  const [a, b, c, d] = o
  if (a === 0) return 'Reserved (0.0.0.0/8)'
  if (a === 10) return 'Private (10.0.0.0/8)'
  if (a === 127) return 'Loopback (127.0.0.0/8)'
  if (a === 100 && b >= 64 && b <= 127) return 'Carrier-grade NAT (100.64.0.0/10)'
  if (a === 169 && b === 254) return 'Link-local (169.254.0.0/16)'
  if (a === 172 && b >= 16 && b <= 31) return 'Private (172.16.0.0/12)'
  if (a === 192 && b === 168) return 'Private (192.168.0.0/16)'
  if (a === 192 && b === 0 && c === 2) return 'Documentation (TEST-NET-1)'
  if (a === 198 && (b === 18 || b === 19)) return 'Benchmarking (198.18.0.0/15)'
  if (a === 198 && b === 51 && c === 100) return 'Documentation (TEST-NET-2)'
  if (a === 203 && b === 0 && c === 113) return 'Documentation (TEST-NET-3)'
  if (a === 255 && b === 255 && c === 255 && d === 255) return 'Broadcast (255.255.255.255)'
  if (a >= 224 && a <= 239) return 'Multicast (224.0.0.0/4)'
  if (a >= 240) return 'Reserved (240.0.0.0/4)'
  return null
}

function ipv6Reason(value: string): string | null {
  const s = value.toLowerCase().split('%')[0] // drop any zone id
  if (s === '::1') return 'Loopback (::1)'
  if (s === '::') return 'Unspecified (::)'
  if (/^f[cd]/.test(s)) return 'Unique-local (fc00::/7)'
  if (/^fe[89ab]/.test(s)) return 'Link-local (fe80::/10)'
  if (/^ff/.test(s)) return 'Multicast (ff00::/8)'
  return null
}

/** A reason the IP is non-routable / special-use (so it shouldn't be enriched), or null if public. */
export function privateIpReason(value: string): string | null {
  if (value.includes(':')) return ipv6Reason(value)
  const o = value.split('.').map((p) => Number(p))
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
  return ipv4Reason(o)
}
