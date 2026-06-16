// Pure indicator-sweep matching — no SQLite, no Electron, so it's unit-testable under Vitest's node
// env (like sql.ts / watchlistMatch.ts). The worker compiles an intel set once with compileIntel(),
// then calls matchText() on every cell it scans. Matching is CASE-INSENSITIVE for every kind.
//
// Match rules (per the indicator's kind):
//   ipv4      whole token — the value must be delimited by non-digits, so 8.8.8.8 matches inside
//             "explorer.exe connected to 8.8.8.8" but NOT inside 18.8.8.81 / 8.8.8.80.
//   hash      whole token — delimited by non-hex (a longer hex run is a different hash). md5/sha1/
//             sha256 all collapse to this one kind (the rule is length-independent).
//   filename  whole token — delimited by non-[a-z0-9._-], so svchost.exe matches in a path but not
//             inside "notsvchost.exe".
//   domain    substring — matches anywhere, so a parent domain is found inside its subdomains
//             ("evil.com" hits "mail.evil.com"). Looser by design (it also hits "devil.com"); a
//             left-boundary tightening is a later refinement.

export type SweepKind = 'ipv4' | 'domain' | 'hash' | 'filename'

export interface IntelEntry {
  value: string
  kind: SweepKind
}

interface CompiledEntry {
  value: string // original case, for recording the sighting
  lc: string // lowercased, for matching
}

export interface CompiledIntel {
  ipv4: CompiledEntry[]
  hash: CompiledEntry[]
  filename: CompiledEntry[]
  domain: CompiledEntry[]
}

const isDigit = (c: string): boolean => c >= '0' && c <= '9'
const isHex = (c: string): boolean => (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')
const isFileChar = (c: string): boolean =>
  (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '.' || c === '_' || c === '-'

/** True if `needle` occurs in `hay` as a whole token — neither neighbouring char is a token char.
 *  `hay`/`needle` are assumed already lowercased. */
function hasToken(hay: string, needle: string, isTokenChar: (c: string) => boolean): boolean {
  if (needle === '') return false
  let i = hay.indexOf(needle)
  while (i !== -1) {
    const before = i === 0 ? '' : hay[i - 1]
    const after = i + needle.length >= hay.length ? '' : hay[i + needle.length]
    if ((before === '' || !isTokenChar(before)) && (after === '' || !isTokenChar(after))) return true
    i = hay.indexOf(needle, i + 1)
  }
  return false
}

// The per-kind match rule registry: ONE row per indicator kind, so adding a kind is a single entry
// (a bucket on CompiledIntel + a row here) — no scattered loops. `test` runs against lowercased text.
// Order here is the order hits are reported within a cell.
interface KindMatcher {
  kind: SweepKind
  test: (hay: string, needle: string) => boolean
}
const KIND_MATCHERS: KindMatcher[] = [
  { kind: 'ipv4', test: (h, n) => hasToken(h, n, isDigit) },
  { kind: 'hash', test: (h, n) => hasToken(h, n, isHex) },
  { kind: 'filename', test: (h, n) => hasToken(h, n, isFileChar) },
  { kind: 'domain', test: (h, n) => h.includes(n) }
]

/** Compile an intel set into per-kind lowercased lists (deduped). Done once; reused per cell. */
export function compileIntel(entries: IntelEntry[]): CompiledIntel {
  const out: CompiledIntel = { ipv4: [], hash: [], filename: [], domain: [] }
  const seen = new Set<string>()
  for (const e of entries) {
    const value = e.value.trim()
    if (value === '') continue
    const bucket = out[e.kind]
    if (!bucket) continue // unknown kind arriving over IPC — ignore rather than crash
    const lc = value.toLowerCase()
    const key = `${e.kind}:${lc}`
    if (seen.has(key)) continue
    seen.add(key)
    bucket.push({ value, lc })
  }
  return out
}

/** Every intel entry whose value is present in `text` per its kind's rule (case-insensitive). */
export function matchText(text: string, intel: CompiledIntel): IntelEntry[] {
  if (text === '') return []
  const hay = text.toLowerCase()
  const hits: IntelEntry[] = []
  for (const m of KIND_MATCHERS) {
    for (const e of intel[m.kind]) if (m.test(hay, e.lc)) hits.push({ value: e.value, kind: m.kind })
  }
  return hits
}
