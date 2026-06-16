// Parse a pasted/loaded intel list into sweep-ready indicators, with per-line feedback. Drives off the
// indicator-kind registry (indicatorKinds.ts) so it has no per-kind branches of its own: in 'classify'
// mode it tries each kind's `detect` (reusing the shared IOC classifier + refang); in 'filename' mode it
// DECLARES every line as a filename (no sniffing — that's how an ambiguous kind enters). The dialog shows,
// live, which lines were accepted, which were normalized (and how), and which were skipped (and why).

import { refang } from '../tools/ioc/patterns'
import { classifyIndicator } from '../tools/ioc/classify'
import { INDICATOR_KINDS, kindDef, type SweepKind } from './indicatorKinds'

export type { SweepKind }

/** How the box is interpreted: auto-classify each line, or treat every line as a declared file name. */
export type ParseMode = 'classify' | 'filename'

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

function parseClassify(raw: string): ParsedLine {
  const refanged = refang(raw).trim()
  const refangNote = refanged.toLowerCase() !== raw.trim().toLowerCase() ? 'refanged' : undefined
  for (const def of INDICATOR_KINDS) {
    if (!def.detect) continue
    const value = def.detect(refanged)
    if (value != null) {
      const note = def.id === 'domain' && value !== refanged ? 'from URL' : refangNote
      return { status: 'ok', value, kind: def.id, original: raw, note }
    }
  }
  // No kind claimed it — use the classifier's verdict for a helpful skip reason.
  const k = classifyIndicator(refanged)
  if (k === 'url') return { status: 'skip', original: raw, reason: 'could not read a domain from the URL' }
  if (k === 'ipv6') return { status: 'skip', original: raw, reason: 'IPv6 not supported yet' }
  if (k === 'email') return { status: 'skip', original: raw, reason: 'email not supported — paste the domain' }
  return { status: 'skip', original: raw, reason: 'not a recognized IPv4 / domain / hash' }
}

function parseDeclaredFilename(raw: string): ParsedLine {
  const def = kindDef('filename')
  const value = def?.declare?.(raw) ?? null
  if (value == null) return { status: 'skip', original: raw, reason: 'not a valid file name' }
  const note = value.toLowerCase() !== raw.trim().toLowerCase() ? 'file name' : undefined
  return { status: 'ok', value, kind: 'filename', original: raw, note }
}

export type IntelCounts = Record<SweepKind, number> & { skipped: number }

export interface ParsedIntel {
  lines: ParsedLine[]
  /** Deduped, sweep-ready entries (what gets sent to the worker). */
  entries: Array<{ value: string; kind: SweepKind }>
  counts: IntelCounts
}

function emptyCounts(): IntelCounts {
  const c = { skipped: 0 } as IntelCounts
  for (const def of INDICATOR_KINDS) c[def.id] = 0
  return c
}

/** Parse a whole paste box. Blank lines are ignored; everything else is accepted or skipped. */
export function parseIntelText(text: string, mode: ParseMode = 'classify'): ParsedIntel {
  const parse = mode === 'filename' ? parseDeclaredFilename : parseClassify
  const lines: ParsedLine[] = []
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === '') continue
    lines.push(parse(raw))
  }
  const seen = new Set<string>()
  const entries: Array<{ value: string; kind: SweepKind }> = []
  const counts = emptyCounts()
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
