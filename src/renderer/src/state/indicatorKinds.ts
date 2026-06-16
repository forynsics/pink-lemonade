// The indicator-kind registry: the single source of truth (renderer side) for every sweepable kind.
// One descriptor per kind carries its label, chip styling, how it's auto-detected from free text, and
// how it's normalized when DECLARED. Adding a kind = add one descriptor here; the parse, the chips,
// and the counts all derive from this list. (The backend matcher has a mirror registry in csv/sweep.ts —
// the two sides share only the kind-id string, which is what crosses the IPC boundary.)
//
// Detection vs. declaration: most kinds are recognized by sniffing the string (reusing the shared IOC
// classifier). Some — like `filename` — are AMBIGUOUS by sniffing (evil.exe is indistinguishable from a
// domain), so they have no `detect` and only enter when a source DECLARES them (e.g. the dialog's
// "treat as file names" mode). Identity comes from the source, not the bytes.

import { classifyIndicator } from '../tools/ioc/classify'

export type SweepKind = 'ipv4' | 'domain' | 'hash' | 'filename'

export interface IndicatorKindDef {
  id: SweepKind
  /** Short label for chips + count summaries ("IP", "Domain", "Hash", "File name"). */
  label: string
  /** Tailwind chip classes (the one place chip colors live — was duplicated across components). */
  chip: string
  /** Auto-detect from a refanged free-text token → the value to sweep, or null if not this kind.
   *  Omitted for DECLARED-ONLY kinds (filename) that can't be told apart by sniffing. */
  detect?: (refanged: string) => string | null
  /** Normalize a value when this kind is explicitly DECLARED (e.g. filename mode) → value or null. */
  declare?: (raw: string) => string | null
}

/** The bare host of a URL (scheme/path/port stripped), or null if it doesn't parse. */
function domainFromUrl(u: string): string | null {
  try {
    const h = new URL(u).hostname
    return h || null
  } catch {
    return null
  }
}

/** Basename of a path, if it's a single file-name token (the matcher's [a-z0-9._-] set), else null. */
function fileBasename(raw: string): string | null {
  const base = (raw.trim().split(/[\\/]/).pop() ?? '').trim()
  if (base === '') return null
  return /^[a-z0-9._-]+$/i.test(base) ? base : null
}

export const INDICATOR_KINDS: IndicatorKindDef[] = [
  {
    id: 'ipv4',
    label: 'IP',
    chip: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300',
    detect: (s) => (classifyIndicator(s) === 'ipv4' ? s : null)
  },
  {
    id: 'domain',
    label: 'domain',
    chip: 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300',
    detect: (s) => {
      const k = classifyIndicator(s)
      if (k === 'domain') return s
      if (k === 'url') return domainFromUrl(s)
      return null
    }
  },
  {
    id: 'hash',
    label: 'hash',
    chip: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
    detect: (s) => {
      const k = classifyIndicator(s)
      return k === 'md5' || k === 'sha1' || k === 'sha256' ? s : null
    }
  },
  {
    id: 'filename',
    label: 'file name',
    chip: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
    // No `detect`: a filename can't be told from a domain by sniffing — declared-only.
    declare: fileBasename
  }
]

const BY_ID = new Map(INDICATOR_KINDS.map((d) => [d.id, d]))

export function kindDef(id: string): IndicatorKindDef | undefined {
  return BY_ID.get(id as SweepKind)
}

/** Chip classes for a kind id (empty string for an unknown kind, so a bad value renders plainly). */
export function kindChip(id: string): string {
  return BY_ID.get(id as SweepKind)?.chip ?? ''
}
