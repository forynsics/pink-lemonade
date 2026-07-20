// Evidence-root path handling: the security boundary for letting the AI agent import its own
// evidence. Kept OUT of db.ts (which imports better-sqlite3 and therefore can't be unit-tested under
// vitest's node runtime) so this containment logic can be exercised against real temp directories.
// db.ts wraps these with the settings lookup that supplies the root.

import { isAbsolute, join, resolve, sep } from 'path'
import { readdirSync, realpathSync, statSync, type Dirent } from 'fs'

/**
 * Resolve an agent-supplied RELATIVE path against `root` and prove it stays inside.
 *
 * A naive `startsWith` check is not enough: it misses `..` traversal, symlinks/junctions pointing
 * outside, and (on Windows) case differences. So we resolve BOTH sides through realpath — which
 * collapses `..` and follows links to their true target — and then compare on a separator boundary,
 * case-insensitively on win32. Anything that escapes, or that we cannot realpath, is rejected.
 * Absolute paths are refused outright: the agent has no business naming one.
 */
export function resolveInsideRoot(root: string, relPath: string): string {
  const raw = String(relPath ?? '').trim()
  if (!raw) throw new Error('A path inside the evidence root is required.')
  if (isAbsolute(raw) || /^[a-zA-Z]:/.test(raw) || raw.startsWith('\\')) {
    throw new Error(`Absolute paths are not accepted — pass a path relative to the evidence root (got "${raw}").`)
  }
  let realRoot: string
  try {
    realRoot = realpathSync(root)
  } catch {
    throw new Error(`The configured evidence root does not exist: ${root}`)
  }
  const target = resolve(realRoot, raw)
  // realpath the target when it exists (following any link to its true home); fall back to the
  // resolved path so a not-found file still gets a containment verdict rather than an escape.
  let realTarget: string
  try {
    realTarget = realpathSync(target)
  } catch {
    realTarget = target
  }
  const norm = (v: string): string => (process.platform === 'win32' ? v.toLowerCase() : v)
  const a = norm(realTarget)
  const b = norm(realRoot)
  const inside = a === b || a.startsWith(b.endsWith(sep) ? b : b + sep)
  if (!inside) throw new Error(`"${raw}" resolves outside the evidence root and was refused.`)
  return realTarget
}

/**
 * Is `child` the same directory as, or inside, `parent`? Non-throwing counterpart to
 * resolveInsideRoot, for validating two ANALYST-chosen directories against each other.
 *
 * Both sides go through realpath where they exist, so a junction or a case variant can't slip past;
 * a path that doesn't exist yet is still compared on its resolved form rather than being waved
 * through. Comparison is on a separator boundary so `…/evidence-archive` is not "inside" `…/evidence`.
 */
export function isInsideDir(child: string, parent: string): boolean {
  if (!child || !parent) return false
  const real = (p: string): string => {
    try {
      return realpathSync(p)
    } catch {
      return resolve(p)
    }
  }
  const norm = (v: string): string => (process.platform === 'win32' ? v.toLowerCase() : v)
  const a = norm(real(child))
  const b = norm(real(parent))
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep)
}

/** One file the agent may import, addressed the only way it can: relative to the evidence root. */
export interface EvidenceFile {
  /** Path RELATIVE to the evidence root, always '/'-separated — what you pass back to import. */
  path: string
  /** Leaf filename. */
  name: string
  /** Top-level subdirectory, which is how a triage package encodes its host ("HOST-A/Amcache.csv"
   *  → "HOST-A"). Null for a file sitting loose at the root. */
  group: string | null
  bytes: number
  /** Whether the ingest engine can take it (CSV/TSV or Excel). Non-importable files are still listed
   *  so the agent can SEE what the package contains rather than silently believing it's absent. */
  importable: boolean
}

// What the ingest engine can actually take, split by which ingester handles it. These MUST match the
// app's own import dialog (csv/ipc.ts) — the agent and the analyst should never disagree about what
// is importable. Delimited files go to the CSV parser (which sniffs the delimiter); Excel workbooks
// go to ExcelJS, one source per worksheet. Anything else is refused with a reason.
const DELIMITED_EXT = /\.(csv|tsv|txt|log)$/i
const EXCEL_EXT = /\.(xlsx|xlsm)$/i

export type EvidenceKind = 'delimited' | 'excel' | 'unsupported'

/** Which ingester (if any) handles this filename. */
export function classifyEvidence(name: string): EvidenceKind {
  if (EXCEL_EXT.test(name)) return 'excel'
  if (DELIMITED_EXT.test(name)) return 'delimited'
  return 'unsupported'
}

/** The file's extension, lowercased and without the dot ('' when it has none). */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/**
 * Why a file can't be imported, phrased for whoever has to act on it.
 *
 * Refusing silently (or worse, "succeeding" by feeding a binary to the CSV parser and producing
 * thousands of garbage rows) is the failure mode this exists to prevent: the agent would go on to
 * reason over nonsense and cite it as evidence. So say what the file is, what we take, and — for the
 * artifact types a triage package actually contains — what would make it importable.
 */
export function unsupportedReason(name: string): string {
  const ext = extensionOf(name)
  const kind = ext ? `a .${ext} file` : 'a file with no extension'
  const hints: Record<string, string> = {
    sqlite: 'It is a SQLite database — export the table you need to CSV first.',
    db: 'It is a database file — export the table you need to CSV first.',
    bmp: 'It is an image (e.g. an RDP bitmap cache artifact), which holds no tabular rows.',
    png: 'It is an image, which holds no tabular rows.',
    jpg: 'It is an image, which holds no tabular rows.',
    zip: 'It is an archive — extract it outside the app, then import the tabular files inside.',
    '7z': 'It is an archive — extract it outside the app, then import the tabular files inside.',
    evtx: 'It is a raw event log — run it through EvtxECmd (or Hayabusa) to produce a CSV first.',
    lnk: 'It is a raw shortcut artifact — run it through LECmd to produce a CSV first.',
    pf: 'It is a raw prefetch artifact — run it through PECmd to produce a CSV first.',
    dat: 'It is a raw artifact — run it through the matching parser to produce a CSV first.',
    pdf: 'It is a document, not tabular data.',
    doc: 'It is a document, not tabular data.',
    docx: 'It is a document, not tabular data.'
  }
  const hint = hints[ext] ? ` ${hints[ext]}` : ''
  return `"${name}" is ${kind}, which this app cannot import.${hint} Importable: tabular text (.csv, .tsv, .txt, .log) and Excel workbooks (.xlsx, .xlsm).`
}

const IMPORTABLE_EXT = { test: (n: string): boolean => classifyEvidence(n) !== 'unsupported' }

/**
 * Does this look like binary content rather than delimited text?
 *
 * The extension is a claim, not proof — a `.csv` holding a memory dump or a renamed image passes the
 * name check and then "imports" as a source with garbage columns and no rows, which the agent has to
 * reason about as if it were evidence. A NUL byte never appears in the delimited text we ingest, so
 * it's a cheap and near-certain binary tell. Only the head is inspected: enough to decide, and it
 * keeps this O(1) on a multi-gigabyte artifact.
 */
export function looksBinary(head: Uint8Array): boolean {
  return detectEncoding(head) === 'binary'
}

/** How a file's bytes should be read — or that they aren't text at all. */
export type TextEncodingKind = 'utf8' | 'utf16le' | 'utf16be' | 'binary'

// Minimum head bytes before the BOM-less UTF-16 parity test is trustworthy.
const MIN_PARITY_SAMPLE = 16

/**
 * Decide how to decode a file from its first bytes.
 *
 * A plain NUL-scan is not good enough: UTF-16 is full of NUL bytes, and the Eric Zimmerman tools that
 * produce half a KAPE package write UTF-16LE console logs. Reading those as "binary" refuses real
 * evidence AND blames the analyst's file extension for our own detector being wrong. So: honour a
 * BOM first, then look at WHERE the NULs fall — UTF-16 ASCII text puts them in every other byte, on a
 * consistent parity, which no real binary format does. Only unpatterned NULs mean binary.
 */
export function detectEncoding(head: Uint8Array): TextEncodingKind {
  if (head.length >= 2) {
    if (head[0] === 0xff && head[1] === 0xfe) return 'utf16le'
    if (head[0] === 0xfe && head[1] === 0xff) return 'utf16be'
  }
  let nulEven = 0
  let nulOdd = 0
  let nuls = 0
  for (let i = 0; i < head.length; i++) {
    if (head[i] !== 0) continue
    nuls++
    if (i % 2 === 0) nulEven++
    else nulOdd++
  }
  if (nuls === 0) return 'utf8'
  // The parity test needs enough bytes to mean anything: in a handful of bytes, "all NULs are even"
  // happens by chance. Below that, a NUL is just a NUL.
  if (head.length < MIN_PARITY_SAMPLE) return 'binary'
  // BOM-less UTF-16: NULs land on one parity only, on roughly every other byte.
  const pairs = Math.floor(head.length / 2)
  const dense = (n: number): boolean => pairs > 0 && n / pairs > 0.3
  if (nulEven === 0 && dense(nulOdd)) return 'utf16le' // 'A',0,'B',0 …
  if (nulOdd === 0 && dense(nulEven)) return 'utf16be' // 0,'A',0,'B' …
  return 'binary'
}

/** Why a file whose NAME passed the check still can't be ingested. */
export function binaryContentReason(name: string): string {
  const ext = extensionOf(name)
  return `"${name}" contains binary data, not delimited text — its .${ext} extension is misleading. Importable: tabular text (.csv, .tsv, .txt, .log) and Excel workbooks (.xlsx, .xlsm).`
}

/** Big-endian UTF-16 is text we recognise but cannot decode — say so, and say what would work. */
export function utf16beReason(name: string): string {
  return `"${name}" is UTF-16 BIG-endian text, which this app cannot decode. Re-save it as UTF-8 (or little-endian UTF-16) and import it again.`
}
// A real KAPE package is far bigger than its importable content: one host's RDP bitmap cache alone
// is thousands of .bmp files. The cap has to clear that comfortably, and hitting it is REPORTED
// (see WalkResult.truncated) rather than silently returning a partial tree as if it were complete.
const WALK_CAP = 100000

// KAPE names a triage target directory `<host>-<drive>.<16-hex-id>` (e.g. "host-a-C.0123456789abcdef").
// The host is the part the analyst actually wants in the Timeline's Host column, so we strip the
// drive+id when the name matches that shape EXACTLY, and otherwise keep the directory name verbatim
// — a heuristic that fires only on the signature it recognizes can't mangle an ordinary folder name.
const KAPE_TARGET_DIR = /^(.+)-[A-Za-z]\.[0-9a-f]{16}$/

/** The host/system label for a top-level evidence directory. */
export function hostLabel(dirName: string): string {
  const m = KAPE_TARGET_DIR.exec(dirName)
  return m ? m[1] : dirName
}

/** Root-relative path split into components, '/'-normalized. */
const parts = (rel: string): string[] => rel.replace(/\\/g, '/').split('/').filter(Boolean)

// How deep we will look for the host directory. A triage package nests a few container levels
// (`<export>/<parsed-modules>/<host>/<category>/file.csv`); past this we are into artifact
// categories, and calling one of those a "host" is worse than reporting no host at all.
const MAX_GROUP_DEPTH = 4

/**
 * Work out WHICH directory level names the host, for a whole set of evidence paths.
 *
 * The host is not reliably the top-level directory. A real KAPE export is
 * `<export>/<parsed-modules>/<host>/<category>/file.csv`, so taking component 0 labelled every
 * file of every machine "sample_logs" — collapsing three hosts into one group, which silently fans
 * host-scoped queries across machines. That is a wrong-answer bug, not an inconvenience.
 *
 * Two rules, in order:
 *  1. If any component matches KAPE's `<host>-<drive>.<16-hex>` target-directory signature, that level
 *     IS the host level — the format is unambiguous, so trust it wherever it sits.
 *  2. Otherwise pick the SHALLOWEST level that actually partitions the set: a container directory has
 *     exactly one name at its level, whereas the host level is where the tree first branches. Levels
 *     are only considered while they are still directories for the paths being examined.
 */
export function inferGroupDepth(relPaths: string[]): number {
  const split = relPaths.map(parts).filter((p) => p.length > 1) // files loose at the root say nothing
  if (split.length === 0) return 0
  for (let d = 0; d < MAX_GROUP_DEPTH; d++) {
    const atDepth = split.filter((p) => p.length > d + 1) // component d is a directory for this path
    if (atDepth.length === 0) break
    if (atDepth.some((p) => KAPE_TARGET_DIR.test(p[d]))) return d
  }
  for (let d = 0; d < MAX_GROUP_DEPTH; d++) {
    const atDepth = split.filter((p) => p.length > d + 1)
    if (atDepth.length === 0) break
    if (new Set(atDepth.map((p) => p[d])).size > 1) return d
  }
  return 0
}

/** The group for one path, given the level the host lives at. Null when the path is shallower. */
export function groupAtDepth(rel: string, depth: number): string | null {
  const p = parts(rel)
  return p.length > depth + 1 ? hostLabel(p[depth]) : null
}

/** The group a root-relative path belongs to when the host is the top-level directory. */
export function groupForPath(rel: string): string | null {
  return groupAtDepth(rel, 0)
}

export interface WalkResult {
  files: EvidenceFile[]
  /** True when the walk hit its cap — the listing is PARTIAL and must be reported as such. */
  truncated: boolean
  /** Which path component named the host for this tree — import must use the SAME level. */
  groupDepth: number
}

/**
 * Walk `start` (a directory at or under `realRoot`) and list its files relative to `realRoot`.
 *
 * Symlinked directories are NOT followed: a link inside the root pointing out of it would otherwise
 * let a listing enumerate anywhere on the machine, and re-checking every descendant is far more
 * fragile than simply not recursing into links. Unreadable directories are skipped rather than
 * failing the whole listing.
 */
export function walkEvidence(realRoot: string, start: string): WalkResult {
  const out: EvidenceFile[] = []
  let truncated = false
  const walk = (dir: string): void => {
    if (out.length >= WALK_CAP) {
      truncated = true
      return
    }
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (out.length >= WALK_CAP) {
        truncated = true
        return
      }
      if (e.isSymbolicLink()) continue
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        walk(full)
        continue
      }
      if (!e.isFile()) continue
      const rel = full.slice(realRoot.length + 1).split(sep).join('/')
      let bytes = 0
      try {
        bytes = statSync(full).size
      } catch {
        /* a file that vanished mid-walk still gets listed, at size 0 */
      }
      out.push({ path: rel, name: e.name, group: null, bytes, importable: IMPORTABLE_EXT.test(e.name) })
    }
  }
  walk(start)
  // Groups are assigned once the WHOLE set is known: which level names the host is a property of the
  // tree, not of any single path (see inferGroupDepth).
  const depth = inferGroupDepth(out.map((f) => f.path))
  for (const f of out) f.group = groupAtDepth(f.path, depth)
  out.sort((a, b) => a.path.localeCompare(b.path))
  return { files: out, truncated, groupDepth: depth }
}

/** `{ext → count}` for files the ingest engine can't take, most numerous first. */
export function summarizeNotImportable(files: EvidenceFile[]): Array<{ type: string; count: number }> {
  const byExt = new Map<string, number>()
  for (const f of files) {
    if (f.importable) continue
    const dot = f.name.lastIndexOf('.')
    const ext = dot > 0 ? f.name.slice(dot + 1).toLowerCase() : '(no extension)'
    byExt.set(ext, (byExt.get(ext) ?? 0) + 1)
  }
  return [...byExt.entries()].sort((a, b) => b[1] - a[1]).map(([type, count]) => ({ type, count }))
}

/**
 * Pick a source label that is unique within a workspace, given the labels already taken.
 *
 * Source names were never unique-constrained, and two hosts in one case routinely yield the same
 * filename (KAPE gives every machine an `Amcache.csv`). A duplicate isn't just untidy: resolveSource
 * rejects an ambiguous bare name outright, so a colliding import would leave that source reachable
 * only by numeric id. We qualify with the group first — that's the information the analyst actually
 * wants to see ("HOST-A — Amcache.csv") — and only fall back to a counter when there's no group or
 * the qualified name collides too, which guarantees this terminates.
 */
/** An existing source, as much of it as naming decisions need. */
export interface ExistingSource {
  id: number
  name: string
  group: string | null
}

export interface NamingPlan {
  /** Label for the incoming source. */
  name: string
}

/**
 * Decide what to call an incoming source. Uniqueness is only enforced WITHIN a group.
 *
 * The `Group/` prefix is already the disambiguator: two hosts each holding
 * "hayabusa_events_offline.csv" are addressable as `host-a/hayabusa_events_offline.csv` and
 * `host-b/hayabusa_events_offline.csv`, and the bare colliding name is rejected as ambiguous by
 * resolveSource — which is the documented, desirable behaviour.
 *
 * An earlier version baked the group into the NAME on a cross-group collision, which was worse in
 * three ways: the path became `host-a/host-a — hayabusa_events_offline.csv` (so the `Group/name` form every
 * tool description gives as THE example did not work); importing a second host RETROACTIVELY renamed
 * the first, invalidating an identifier already handed back to the caller; and the prefix appeared
 * only on colliding names, so there was no uniform rule to build a path from a filename.
 *
 * That leaves one genuine collision: two files with the SAME name in the SAME group, which no path
 * can tell apart. A counter is the honest answer there — a group prefix would read identically on
 * both.
 */
export function planSourceNaming(desired: string, group: string | null, existing: ExistingSource[]): NamingPlan {
  const sameGroup = existing.filter((e) => (e.group ?? null) === (group ?? null))
  return { name: pickUniqueName(desired, null, sameGroup.map((e) => e.name)) }
}

export function pickUniqueName(desired: string, group: string | null, taken: Iterable<string>): string {
  const seen = new Set<string>()
  for (const t of taken) seen.add(t.toLowerCase())
  const free = (n: string): boolean => !seen.has(n.toLowerCase())
  if (free(desired)) return desired
  if (group) {
    const qualified = `${group} — ${desired}`
    if (free(qualified)) return qualified
  }
  for (let i = 2; i < 1000; i++) {
    const n = `${desired} (${i})`
    if (free(n)) return n
  }
  return `${desired} (${Date.now()})`
}
