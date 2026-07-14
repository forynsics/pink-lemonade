// Main-side indicator classifier for the AI toolbox. The renderer's tools/ioc/classify.ts can't be
// imported here (the main/renderer tsconfigs don't share modules), so this is a faithful port of the
// same anchored matcher + patterns/ioc regexes, kept in sync by value. It adds the ipv6 branch the
// renderer classifier lacks. One string → one IndicatorKind (the broadest, domain, is tried last).

import type { IndicatorKind } from '../enrich/providers/types'

const IPV4 = /(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)/
const IPV6 =
  /(?:(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|(?:[0-9a-fA-F]{1,4}:){1,7}:|(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|(?:[0-9a-fA-F]{1,4}:){1,5}(?::[0-9a-fA-F]{1,4}){1,2}|(?:[0-9a-fA-F]{1,4}:){1,4}(?::[0-9a-fA-F]{1,4}){1,3}|(?:[0-9a-fA-F]{1,4}:){1,3}(?::[0-9a-fA-F]{1,4}){1,4}|(?:[0-9a-fA-F]{1,4}:){1,2}(?::[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:(?::[0-9a-fA-F]{1,4}){1,6}|:(?:(?::[0-9a-fA-F]{1,4}){1,7}|:))/
const SHA256 = /[a-fA-F0-9]{64}/
const SHA1 = /[a-fA-F0-9]{40}/
const MD5 = /[a-fA-F0-9]{32}/
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/
const URL = /(?:https?|ftp):\/\/[^\s<>"'`\])}]+/i
const DOMAIN = /(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}/

function whole(re: RegExp): RegExp {
  return new RegExp(`^(?:${re.source})$`, re.flags.replace('g', ''))
}

// Order matters: hashes by length, then IPs, URL, email, domain (broadest) last.
const ANCHORS: Array<{ kind: IndicatorKind; re: RegExp }> = [
  { kind: 'sha256', re: whole(SHA256) },
  { kind: 'sha1', re: whole(SHA1) },
  { kind: 'md5', re: whole(MD5) },
  { kind: 'ipv4', re: whole(IPV4) },
  { kind: 'ipv6', re: whole(IPV6) },
  { kind: 'url', re: whole(URL) },
  { kind: 'email', re: whole(EMAIL) },
  { kind: 'domain', re: whole(DOMAIN) }
]

/** Classify one indicator string into a kind, or null if it matches none. */
export function classifyIndicator(value: string): IndicatorKind | null {
  const v = value.trim()
  if (!v) return null
  for (const { kind, re } of ANCHORS) if (re.test(v)) return kind
  return null
}
