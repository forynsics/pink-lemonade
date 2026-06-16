// Parse a pasted intel list into sweep-ready indicators, with per-line feedback. Reuses the shared
// IOC classifier + refang (one source of truth in tools/ioc) so the dialog can show, live, which
// lines were accepted, which were normalized (and how), and which were skipped (and why).

import { classifyIndicator } from '../tools/ioc/classify'
import { refang } from '../tools/ioc/patterns'

/** The indicator kinds the sweep matcher supports (file names land later, via the intel grid). */
export type SweepKind = 'ipv4' | 'domain' | 'hash'

export interface ParsedOk {
  status: 'ok'
  value: string // normalized value actually swept for
  kind: SweepKind
  original: string // the raw line, for the before→after display
  /** Set when the value was changed (e.g. 'from URL', 'refanged'); drives the before→after hint. */
  note?: string
}
export interface ParsedSkip {
  status: 'skip'
  original: string
  reason: string
}
export type ParsedLine = ParsedOk | ParsedSkip

/** The bare host of a URL (scheme/path/port stripped), or null if it doesn't parse. */
function domainFromUrl(u: string): string | null {
  try {
    const h = new URL(u).hostname
    return h || null
  } catch {
    return null
  }
}

function parseLine(raw: string): ParsedLine {
  const refanged = refang(raw).trim()
  const wasRefanged = refanged.toLowerCase() !== raw.trim().toLowerCase()
  const refangNote = wasRefanged ? 'refanged' : undefined
  const kind = classifyIndicator(refanged)
  if (kind === 'ipv4') return { status: 'ok', value: refanged, kind: 'ipv4', original: raw, note: refangNote }
  if (kind === 'md5' || kind === 'sha1' || kind === 'sha256')
    return { status: 'ok', value: refanged, kind: 'hash', original: raw, note: refangNote }
  if (kind === 'domain') return { status: 'ok', value: refanged, kind: 'domain', original: raw, note: refangNote }
  if (kind === 'url') {
    const dom = domainFromUrl(refanged)
    if (dom) return { status: 'ok', value: dom, kind: 'domain', original: raw, note: 'from URL' }
    return { status: 'skip', original: raw, reason: 'could not read a domain from the URL' }
  }
  if (kind === 'ipv6') return { status: 'skip', original: raw, reason: 'IPv6 not supported yet' }
  if (kind === 'email') return { status: 'skip', original: raw, reason: 'email not supported — paste the domain' }
  return { status: 'skip', original: raw, reason: 'not a recognized IPv4 / domain / hash' }
}

export interface ParsedIntel {
  lines: ParsedLine[]
  /** Deduped, sweep-ready entries (what gets sent to the worker). */
  entries: Array<{ value: string; kind: SweepKind }>
  counts: { ipv4: number; domain: number; hash: number; skipped: number }
}

/** Parse a whole paste box. Blank lines are ignored; everything else is accepted or skipped. */
export function parseIntelText(text: string): ParsedIntel {
  const lines: ParsedLine[] = []
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === '') continue
    lines.push(parseLine(raw))
  }
  const seen = new Set<string>()
  const entries: Array<{ value: string; kind: SweepKind }> = []
  const counts = { ipv4: 0, domain: 0, hash: 0, skipped: 0 }
  for (const l of lines) {
    if (l.status === 'skip') {
      counts.skipped++
      continue
    }
    const key = `${l.kind}:${l.value.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    entries.push({ value: l.value, kind: l.kind })
    counts[l.kind]++
  }
  return { lines, entries, counts }
}
