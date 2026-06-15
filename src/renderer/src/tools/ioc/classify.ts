// Classify a single string into an indicator kind, reusing the shared IOC regexes (the single
// source of truth in patterns.ts). Used by the "Send to Enrichment" handoffs to tag values before
// they're sent. Anchored, full-string matches (not the global extractors) so one value → one kind.

import { IPV4, DOMAIN, SHA256, SHA1, MD5, EMAIL, URL } from './patterns'
import type { IndicatorKind } from '../../state/enrichTypes'

/** Build an anchored, non-global clone of a shared pattern (full-string test, no lastIndex state). */
function whole(re: RegExp): RegExp {
  return new RegExp(`^(?:${re.source})$`, re.flags.replace('g', ''))
}

const ANCHORS: Array<{ kind: IndicatorKind; re: RegExp }> = [
  // Order matters: hashes by length, then IP, URL, email, domain (broadest last).
  { kind: 'sha256', re: whole(SHA256) },
  { kind: 'sha1', re: whole(SHA1) },
  { kind: 'md5', re: whole(MD5) },
  { kind: 'ipv4', re: whole(IPV4) },
  { kind: 'url', re: whole(URL) },
  { kind: 'email', re: whole(EMAIL) },
  { kind: 'domain', re: whole(DOMAIN) }
]

/** The indicator kind of a trimmed value, or null if it doesn't look like a recognized indicator. */
export function classifyIndicator(value: string): IndicatorKind | null {
  const v = value.trim()
  if (!v) return null
  for (const { kind, re } of ANCHORS) if (re.test(v)) return kind
  return null
}
