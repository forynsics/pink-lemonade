// Pure parsing/normalization for watchlist entries — no SQLite, no Electron, so it's unit-testable
// under Vitest's node env (like sql.ts / ipranges.ts). watchlistStore.ts uses these to turn a pasted
// line into a stored entry, and to turn a looked-up indicator into the value it matches on.
//
// An entry is normalized to either an integer range [lo,hi] (IPv4 / CIDR) or a `norm` string
// (IPv6 exact, ASN number, lowercased domain/hash). The store then matches an IP by range
// containment and everything else by exact `norm`.

export type WatchlistKind = 'ip' | 'asn' | 'domain' | 'hash'

export interface NormalizedEntry {
  /** IPv4 range start (uint32), inclusive. Present for IPv4/CIDR entries. */
  lo?: number
  /** IPv4 range end (uint32), inclusive. Single IP ⇒ lo === hi. */
  hi?: number
  /** Exact-match key: IPv6 string, ASN number, or lowercased domain/hash. */
  norm?: string
}

/** "a.b.c.d" → uint32, or null if it isn't a valid dotted-quad IPv4. */
export function ipv4ToInt(s: string): number | null {
  const parts = s.trim().split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null
    const o = Number(p)
    if (o > 255) return null
    n = n * 256 + o
  }
  return n // 0 .. 4294967295
}

/** "a.b.c.d" or "a.b.c.d/n" → an inclusive uint32 range, or null. IPv4 only. */
export function parseIpEntry(raw: string): { lo: number; hi: number } | null {
  const s = raw.trim()
  const slash = s.indexOf('/')
  if (slash === -1) {
    const ip = ipv4ToInt(s)
    return ip == null ? null : { lo: ip, hi: ip }
  }
  const ip = ipv4ToInt(s.slice(0, slash))
  const bitsStr = s.slice(slash + 1).trim()
  if (ip == null || !/^\d{1,2}$/.test(bitsStr)) return null
  const bits = Number(bitsStr)
  if (bits > 32) return null
  if (bits === 0) return { lo: 0, hi: 0xffffffff }
  const mask = (0xffffffff << (32 - bits)) >>> 0
  const lo = (ip & mask) >>> 0
  const hi = lo + (2 ** (32 - bits) - 1)
  return { lo, hi }
}

/** "AS15169" / "asn 15169" / "15169" → "15169"; null if not a plain ASN number. */
export function normalizeAsn(raw: string): string | null {
  const s = raw.trim().replace(/^as(n)?\s*/i, '')
  return /^\d{1,10}$/.test(s) ? String(Number(s)) : null
}

/** Lowercased bare host (scheme/path/port/trailing-dot stripped), or null if it isn't domain-shaped. */
export function normalizeDomain(raw: string): string | null {
  let s = raw.trim().toLowerCase()
  if (s === '') return null
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '') // scheme
  s = s.replace(/[/?#].*$/, '') // path / query / fragment
  s = s.replace(/:\d+$/, '') // port
  s = s.replace(/\.$/, '') // trailing dot
  // labels of [a-z0-9-] (not leading/trailing '-'), at least two, last looks like a TLD.
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(s)) return null
  return s
}

/** Lowercased hex hash of md5/sha1/sha256 length, or null. */
export function normalizeHash(raw: string): string | null {
  const s = raw.trim().toLowerCase()
  return /^(?:[0-9a-f]{32}|[0-9a-f]{40}|[0-9a-f]{64})$/.test(s) ? s : null
}

/** Lowercased IPv6 (zone id dropped). NOT canonicalized — matching is exact-string in Phase 1. */
export function normalizeIpv6(raw: string): string | null {
  const s = raw.trim().toLowerCase().split('%')[0]
  if (!s.includes(':') || !/^[0-9a-f:]+$/.test(s)) return null
  return s
}

/** Turn one pasted line into a stored entry for `kind`, or null if it doesn't parse (→ "skipped"). */
export function normalizeEntry(kind: WatchlistKind, raw: string): NormalizedEntry | null {
  const s = raw.trim()
  if (s === '') return null
  if (kind === 'ip') {
    if (s.includes(':')) {
      const v6 = normalizeIpv6(s)
      return v6 ? { norm: v6 } : null
    }
    return parseIpEntry(s)
  }
  if (kind === 'asn') {
    const a = normalizeAsn(s)
    return a ? { norm: a } : null
  }
  if (kind === 'domain') {
    const d = normalizeDomain(s)
    return d ? { norm: d } : null
  }
  const h = normalizeHash(s)
  return h ? { norm: h } : null
}
