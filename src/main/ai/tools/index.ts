// The AI toolbox. Each tool maps to an existing deterministic capability so the model is grounded —
// it learns indicators only by calling enrichment, and analyzes the case data only by querying the
// SQL layer (counts + small samples, never raw rows). Phase 1 tools are all read-only ('free');
// gated action tools (apply filter / enrich / tag / sweep) land in a later phase.
//
// Everything runs headless in main through the existing worker proxies (dbClient). Column ids are
// always c<n>, run through the same normalizeFilters/normalizeOpts sanitizer the csv:* IPC uses, so
// a malformed AI filter is rejected at the boundary and never reaches SQL.

import * as dbw from '../../csv/dbClient'
import { normalizeFilters, normalizeOpts } from '../../csv/ipc'
import { compileIntel, matchText, type SweepKind } from '../../csv/sweep'
import { resolveTechnique } from '../attack'
import { classifyIndicator } from '../classify'
import { coverageUniverse } from '../coverage'
import { resolveCol, resolveFilterCols } from '../colmap'
import { pathOf, resolveSource } from '../sources'
import { envelopeOf, resolveTimeColumn, spansByColumn, timeColumnsOf, toEpochSeconds, type ColSpan } from '../timecols'
import type { AiTool, CoverageTracker, ToolDeps, WsColumn, WsCtx, WsSource } from '../types'

// The standard `source` param (every data tool accepts it; defaults to the on-screen source).
const SOURCE_PARAM = {
  source: {
    type: 'string',
    description:
      'Which source/artifact to target. Accepts a name, a group-qualified path "Group/name" (e.g. "DESKTOP6/hayabusa_events_offline.csv"), or the numeric id from list_sources. Use the PATH or id when multiple hosts share a filename — a bare colliding name is rejected. Omit to use the source currently on screen.'
  }
} as const

// Persisted intent-tag ids — MUST match the renderer's TagId (state/tags.ts), which is lowercase.
// The grid looks tags up by these ids, so storing a different case wouldn't render.
const TAG_VALUES = ['malicious', 'suspicious', 'unknown', 'benign'] as const
type TagValue = (typeof TAG_VALUES)[number]
// Loose synonyms so a model phrasing ("bad", "clean", "flag as threat") still maps to a valid tag.
const TAG_SYNONYMS: Record<string, TagValue> = {
  bad: 'malicious', evil: 'malicious', threat: 'malicious', malware: 'malicious', compromised: 'malicious', flagged: 'malicious',
  suspect: 'suspicious', anomalous: 'suspicious',
  clean: 'benign', safe: 'benign', good: 'benign', legit: 'benign', legitimate: 'benign', normal: 'benign',
  unsure: 'unknown', unclear: 'unknown', unverified: 'unknown'
}
const tagLabel = (id: string): string => id.charAt(0).toUpperCase() + id.slice(1)
// Benign is the analyst's call, not the AI's — surface a reminder on its confirm card.
const benignNote = (tag: string): string => (tag === 'benign' ? '⚠ Benign is the analyst’s determination — confirm only if you agree. ' : '')

// Fixed IOC taxonomy (canonical id → display label), grouped Primary / Secondary / Tertiary. Kept
// stable so the AI's IOC catalog is consistent.
const IOC_TYPES: Record<string, string> = {
  ip: 'IP', domain: 'Domain', url: 'URL', email: 'Email', hash: 'File Hash',
  filename: 'Filename', filepath: 'File Path', process: 'Process', commandline: 'Command Line', useragent: 'User Agent', cloud: 'Cloud Identifier',
  registry: 'Registry', service: 'Service', scheduledtask: 'Scheduled Task', mutex: 'Mutex', namedpipe: 'Named Pipe', tlsfingerprint: 'TLS Fingerprint', certificate: 'Certificate', pdbpath: 'PDB Path'
}
const IOC_SYNONYMS: Record<string, string> = {
  ipv4: 'ip', ipv6: 'ip', ipaddress: 'ip', address: 'ip',
  md5: 'hash', sha1: 'hash', sha256: 'hash', filehash: 'hash', sha: 'hash',
  fqdn: 'domain', hostname: 'domain', host: 'domain',
  path: 'filepath', file: 'filename',
  cmd: 'commandline', cmdline: 'commandline', command: 'commandline',
  ua: 'useragent',
  ja3: 'tlsfingerprint', jarm: 'tlsfingerprint', tls: 'tlsfingerprint', fingerprint: 'tlsfingerprint',
  cert: 'certificate', thumbprint: 'certificate',
  task: 'scheduledtask', scheduled: 'scheduledtask',
  pipe: 'namedpipe',
  reg: 'registry', regkey: 'registry', registrykey: 'registry',
  svc: 'service',
  appid: 'cloud', tenantid: 'cloud', accesskey: 'cloud', accesskeyid: 'cloud',
  pdb: 'pdbpath'
}
/** Normalize a model-supplied IOC type to a canonical taxonomy id, tolerating case + synonyms. */
function normalizeIocType(v: unknown): string | null {
  const s = String(v ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '')
  if (!s) return null
  return IOC_TYPES[s] ? s : (IOC_SYNONYMS[s] ?? null)
}

const SAMPLE_CAP = 25 // max rows returned to the model from query_workspace / find_rows
const CELL_CAP = 200 // max chars per cell in a sample (keeps token use bounded)
const DISTINCT_CAP = 200
const CANDIDATE_CAP = 2000 // find_rows: substring candidates pulled back for whole-token filtering
const EVIDENCE_RID_CAP = 500 // record_event: max rowids stored per evidence item (the pivot lands on these exact rows)

let reqSeq = 1_000_000 // a high range so AI tool reqIds don't collide with the renderer's

/** Map an arbitrary value to a sweep matcher kind for whole-token matching (null = substring). */
function sweepKindOf(value: string): SweepKind | null {
  const k = classifyIndicator(value)
  if (k === 'ipv4') return 'ipv4'
  if (k === 'md5' || k === 'sha1' || k === 'sha256') return 'hash'
  if (k === 'domain') return 'domain'
  return null
}

function clipTo(v: string, cap: number): string {
  return v.length > cap ? v.slice(0, cap) + '…' : v
}
function clip(v: string): string {
  return clipTo(v, CELL_CAP)
}
/** Epoch SECONDS → ISO-8601 UTC, the timeline-friendly form the model reasons over. */
function isoUtc(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString()
}

/** Turn a row's positional cells into a labelled object keyed by display header. `cap` bounds each
 *  cell (default CELL_CAP; get_all_rows passes a larger cap so short artifacts read in full). */
function rowToObject(cells: string[], columns: WsColumn[] | undefined, cap: number = CELL_CAP): Record<string, string> {
  const out: Record<string, string> = {}
  cells.forEach((cell, i) => {
    const label = columns?.[i]?.original ?? `c${i}`
    out[label] = clipTo(cell ?? '', cap)
  })
  return out
}

export interface ToolOutcome {
  result: unknown
  /** Short one-line summary for the UI tool-call card. */
  card: string
}

interface MatchSet {
  rids: number[]
  rows: string[][]
  matchType: 'whole-token' | 'contains'
  substringCount: number
  /** Whether the full match set fit under CANDIDATE_CAP (so rids/rows are exhaustive). */
  complete: boolean
  colLabel?: string
}

/** Find rows in `src` containing `value` (whole-token for IPs/hashes via the sweep matcher,
 *  substring otherwise), restricted to `column` if given. Returns matching rids+rows (capped) and
 *  the count. Shared by find_rows (reporting) and tag_rows/mark_rows (mutation by rid). */
async function findMatches(src: WsSource, value: string, column?: unknown, extraFilters?: unknown[]): Promise<MatchSet> {
  const tabId = src.tabId
  const colRef = column != null && String(column) ? resolveCol(column, src.columns) : undefined
  const colIdx = colRef ? src.columns.findIndex((c) => c.name === colRef) : -1
  const search = colRef ? undefined : value
  // The containment predicate (column LIKE, or free-text search) AND'd with any extra filters (a time window).
  const clauses: unknown[] = []
  if (colRef) clauses.push({ col: colRef, op: 'like', value })
  if (extraFilters && extraFilters.length) clauses.push(...extraFilters)
  const filters = clauses.length ? normalizeFilters(clauses as never) : undefined
  const substringCount = (await dbw.count(tabId, reqSeq++, filters, search ?? '', () => {})) ?? 0
  const page = (await dbw.call('queryRows', tabId, normalizeOpts({ filters, search, limit: CANDIDATE_CAP, offset: 0 } as never))) as {
    rows: string[][]
    rids: number[]
  }
  const rows = page.rows ?? []
  const rids = page.rids ?? []
  const colLabel = colRef ? src.columns.find((c) => c.name === colRef)?.original ?? colRef : undefined
  const complete = substringCount <= CANDIDATE_CAP

  const sk = sweepKindOf(value)
  if (sk && sk !== 'domain') {
    const intel = compileIntel([{ value, kind: sk }])
    const keptRows: string[][] = []
    const keptRids: number[] = []
    rows.forEach((r, i) => {
      const cells = colIdx >= 0 ? [r[colIdx] ?? ''] : r
      if (cells.some((cell) => matchText(cell ?? '', intel).length > 0)) {
        keptRows.push(r)
        keptRids.push(rids[i])
      }
    })
    return { rids: keptRids, rows: keptRows, matchType: 'whole-token', substringCount, complete, colLabel }
  }
  return { rids, rows, matchType: 'contains', substringCount, complete, colLabel }
}

/** Build the optional time-window filter (a `timerange` clause) for a tool that accepts time_from/
 *  time_to/time_column. Returns [] when no window is requested. Throws (with the model-facing message
 *  from resolveTimeColumn) when the column is ambiguous, or when the bounds don't parse. */
function timeWindowFilter(src: WsSource, args: Record<string, unknown>): unknown[] {
  const hasFrom = args.time_from != null && String(args.time_from).trim() !== ''
  const hasTo = args.time_to != null && String(args.time_to).trim() !== ''
  if (!hasFrom && !hasTo) return []
  const tc = resolveTimeColumn(src, args.time_column)
  const from = hasFrom ? toEpochSeconds(args.time_from) : undefined
  const to = hasTo ? toEpochSeconds(args.time_to) : undefined
  if ((hasFrom && from == null) || (hasTo && to == null)) {
    throw new Error('Could not parse time_from/time_to — use ISO (e.g. 2026-06-13T18:00:00Z) or epoch seconds.')
  }
  return [{ col: tc.id, op: 'timerange', tkind: tc.kind, from, to }]
}

/** The sources a fan-out tool should search, optionally narrowed to one or more GROUPS (the host/system
 *  scope). Case-insensitive match on the group label. This is the guardrail against cross-system
 *  contamination: a single-host investigation passes the host's group(s) and never sees other systems'
 *  artifacts. No groups → every source. Returns the scope label list for honest reporting. */
function scopedSources(sources: WsSource[], groupsArg: unknown): { sources: WsSource[]; scopedTo: string[] | null } {
  const groups = Array.isArray(groupsArg) ? groupsArg.map((g) => String(g).trim()).filter(Boolean) : []
  if (groups.length === 0) return { sources, scopedTo: null }
  const want = new Set(groups.map((g) => g.toLowerCase()))
  return { sources: sources.filter((s) => s.group != null && want.has(s.group.toLowerCase())), scopedTo: groups }
}

/** Normalize a model-supplied plan-step status to pending|active|done (default pending). */
function normPlanStatus(v: unknown): 'pending' | 'active' | 'done' {
  const s = String(v ?? '').trim().toLowerCase()
  return s === 'done' || s === 'active' ? s : 'pending'
}

/** Normalize a model-supplied tag to a persisted tag id, tolerating case, labels, and synonyms. */
function normalizeTag(v: unknown): TagValue | null {
  const s = String(v ?? '').trim().toLowerCase()
  if (!s) return null
  return TAG_VALUES.find((t) => t === s) ?? TAG_VALUES.find((t) => s.includes(t)) ?? TAG_SYNONYMS[s] ?? null
}

// ---- Tool definitions (JSON Schema) advertised to the model ----

export const TOOL_DEFS: AiTool[] = [
  {
    name: 'list_sources',
    description:
      'List every source (imported artifact/CSV) in the open workspace — e.g. the many files of a KAPE triage package plus a Hayabusa timeline. Returns each source\'s name, a path-style `path` ("Group/name") and numeric `id` for unambiguous targeting (use these, not the bare name, when hosts share a filename), row count, column count, and its `group` (the analyst-assigned host/system/origin the artifact came from, e.g. "DESKTOP6", "PaloAlto-Perimeter", or null when ungrouped), plus a `groups` summary listing the sources in each group. Use the groups to scope an investigation to one host/system and to corroborate ACROSS the artifacts of the same machine. CALL THIS FIRST to learn what artifacts you have, then investigate ACROSS them: corroborate a finding in one source (e.g. a binary in a Hayabusa detection) against others (Amcache, Prefetch, MFT, registry, …). Pass a source name to the other tools via their `source` argument.',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'describe_workspace',
    description:
      'Return the full schema of one source: its name, row count, and columns (each with an `id` like "c3" to use in filters, a display `label`, and whether it is a time column). Use list_sources first to pick a source, then describe it before querying.',
    parameters: { type: 'object', properties: { ...SOURCE_PARAM }, additionalProperties: false }
  },
  {
    name: 'find_rows',
    description:
      'Find rows where a value appears — the right tool to check whether a specific indicator (IP, domain, file hash, filename) or any string occurs in a source. Case-insensitive containment: for IPs and hashes it matches the value as a WHOLE TOKEN (so 158.23.160.187 is found inside a log line but not inside 158.23.160.1870); for domains and other text it matches as a substring. Optionally restrict to one column, OR to a time window (time_from/time_to) for timeline correlation. Returns the match count plus a small sample. ALWAYS use this (not query_workspace with op "eq") to answer "are there rows with X?". Run it across sources to corroborate an artifact.',
    parameters: {
      type: 'object',
      properties: {
        value: { type: 'string', description: 'The value or indicator to look for anywhere in a row.' },
        column: { type: 'string', description: 'Optional column id (c0, c1, …) or label to restrict the search to.' },
        time_from: { type: 'string', description: 'Optional lower time bound (ISO like 2026-06-13T18:00:00Z, or epoch seconds) — restrict to rows at/after this time.' },
        time_to: { type: 'string', description: 'Optional upper time bound (ISO or epoch seconds) — restrict to rows at/before this time.' },
        time_column: { type: 'string', description: 'Which time column the window applies to (id or label). Required only when the source has more than one time column (e.g. MFT Created vs Modified).' },
        ...SOURCE_PARAM
      },
      required: ['value'],
      additionalProperties: false
    }
  },
  {
    name: 'find_in_all_sources',
    description:
      'Search a value across loaded sources at once and return, per source, the match count and a small sample — the fast way to answer "where does this appear?" without calling find_rows on each artifact. Use it to find which artifacts corroborate an indicator (a binary, hash, account, path), then call find_rows on a specific source for the exact whole-token rows. Counts here are CONTAINS (substring) counts; for an IP/hash the precise whole-token count comes from find_rows on that source. SCOPE: by default this fans out across EVERY loaded source — when you are investigating a single host/system (or the analyst scoped you to one), pass `groups` (e.g. ["DESKTOP6"]) so it only searches that host\'s sources and never pulls in another system\'s artifacts.',
    parameters: {
      type: 'object',
      properties: {
        value: { type: 'string', description: 'The value/indicator to look for.' },
        groups: { type: 'array', items: { type: 'string' }, description: 'Optional: restrict the search to sources in these host/system groups (from list_sources). Omit to search every loaded source.' },
        sample: { type: 'number', description: 'Rows to sample per matching source (default 3, max 15) — raise it to read structured artifacts (ShellBags, AppCompatCache) without a follow-up find_rows.' }
      },
      required: ['value'],
      additionalProperties: false
    }
  },
  {
    name: 'get_all_rows',
    description:
      'Return EVERY row of a SMALL source (≤200 rows) in one call — for short, high-value artifacts like PowerShell console history, ShellBags, or LNK output where reading every line matters and targeted searches would miss context. Refuses for larger sources (use find_rows / query_workspace there). Check a source\'s row count with list_sources or describe_workspace first.',
    parameters: { type: 'object', properties: { ...SOURCE_PARAM }, additionalProperties: false }
  },
  {
    name: 'find_around_time',
    description:
      'Cross-source TEMPORAL pivot — find rows within ±N seconds of a timestamp across loaded sources, the fast way to align an event\'s traces in time ("what else happened within 60s of this Hayabusa detection?"). For each source with a single time column it applies the window automatically; sources with NO time column, or with several (ambiguous), are returned under `skipped` so you can target them with find_rows + an explicit time_column. Optionally narrow to rows that also contain a value. Returns per-source counts + a tiny sample. SCOPE: by default it fans out across EVERY loaded source — when investigating a single host/system, pass `groups` (e.g. ["DESKTOP6"]) so it only correlates within that host\'s sources.',
    parameters: {
      type: 'object',
      properties: {
        timestamp: { type: 'string', description: 'The anchor time (ISO like 2026-06-13T17:09:02Z, or epoch seconds).' },
        within_sec: { type: 'number', description: 'Half-window in seconds (default 60): matches rows whose time is within ±this of the anchor.' },
        groups: { type: 'array', items: { type: 'string' }, description: 'Optional: restrict to sources in these host/system groups (from list_sources). Omit to search every loaded source.' },
        value: { type: 'string', description: 'Optional: only rows that also contain this value (contains match).' }
      },
      required: ['timestamp'],
      additionalProperties: false
    }
  },
  {
    name: 'query_workspace',
    description:
      'Count rows in a source matching structured filters (and/or a contains search) and return a small sample. Use this for structured questions ("how many rows where status=denied", time ranges, multiple conditions). NEVER assume row values — call this to see real data. Use column `id`s (c0, c1, …) from describe_workspace. To simply check whether a value/indicator appears anywhere, prefer find_rows. Returns the total match count plus up to 25 sample rows.',
    parameters: {
      type: 'object',
      properties: {
        filters: {
          type: 'array',
          description:
            'Filter clauses, ANDed together. Each is one of: {col, op:"like"|"nlike", value} (like = CONTAINS, the usual choice for matching text); {col, op:"eq"|"neq", value} (EXACT — matches only when the whole cell equals value, e.g. a status code; do NOT use eq to look for a value inside log text); {col, op:"in", values:[...]}; {col, op:"timerange", tkind:"iso"|"epoch_s"|"epoch_ms", from?, to?} where from/to are epoch SECONDS.',
          items: { type: 'object' }
        },
        search: { type: 'string', description: 'Free-text term matched across all columns (contains).' },
        limit: { type: 'number', description: 'Sample rows to return (max 25).' },
        ...SOURCE_PARAM
      },
      additionalProperties: false
    }
  },
  {
    name: 'tag_rows',
    description:
      'Flag rows in a source with an intent tag (Malicious, Suspicious, Unknown, or Benign). This MODIFIES the analyst\'s workspace, so it always requires the user to confirm before it runs, and tags applied this way are recorded as AI-applied. Do NOT apply "Benign" on your own initiative — clearing something as benign is the analyst\'s determination; only use Benign when the analyst explicitly asks, and explain your reasoning first. Target rows EITHER by a value (same matching as find_rows) OR by structured filters/search. Propose this when the analyst asks you to flag/mark/tag findings.',
    parameters: {
      type: 'object',
      properties: {
        tag: { type: 'string', enum: ['Malicious', 'Suspicious', 'Unknown', 'Benign'], description: 'The intent tag to apply.' },
        value: { type: 'string', description: 'Tag every row containing this value/indicator (whole-token for IPs/hashes). Use this OR filters/search.' },
        column: { type: 'string', description: 'With `value`, restrict matching to this column id/label.' },
        filters: { type: 'array', items: { type: 'object' }, description: 'Tag rows matching these filters (same shape as query_workspace). Use this OR value.' },
        search: { type: 'string', description: 'Tag rows containing this term across all columns. Use this OR value.' },
        ...SOURCE_PARAM
      },
      required: ['tag'],
      additionalProperties: false
    }
  },
  {
    name: 'set_source_group',
    description:
      'Assign a source (imported artifact) to a GROUP — the host/system/origin it came from (e.g. "DESKTOP6", "DC1", "PaloAlto-Perimeter"). This is the analyst-facing grouping shown in the sidebar and used as the Timeline\'s Host. Use it to attribute artifacts to the right machine once you work out which file came from where (e.g. all of a KAPE package\'s CSVs belong to one host). This CHANGES the workspace and REQUIRES the analyst to confirm before it applies. Pass an empty group to remove a source from its group. Set one source per call.',
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Which source/artifact to (re)group — a name (or id) from list_sources.' },
        group: { type: 'string', description: 'The group label (host/system/origin). Empty string removes the source from its group.' }
      },
      required: ['source', 'group'],
      additionalProperties: false
    }
  },
  {
    name: 'mark_rows',
    description:
      'Record an AI-accountability mark (✨) on the rows you are asserting something about during triage/investigation, so the analyst can afterward filter the grid to exactly what you flagged. This is NOT an intent judgment (use tag_rows for Malicious/Suspicious/etc) and needs NO confirmation — it only adds a reviewable ✨ mark and cannot change anything else. Use it freely as you build your findings: mark the rows behind each claim, with a short note of why. Target by value (same matching as find_rows) or by filters/search, in any source.',
    parameters: {
      type: 'object',
      properties: {
        value: { type: 'string', description: 'Mark every row containing this value (whole-token for IPs/hashes). Use this OR filters/search.' },
        column: { type: 'string', description: 'With `value`, restrict to this column id/label.' },
        filters: { type: 'array', items: { type: 'object' }, description: 'Mark rows matching these filters (same shape as query_workspace). Use this OR value.' },
        search: { type: 'string', description: 'Mark rows containing this term across all columns. Use this OR value.' },
        note: { type: 'string', description: 'Short note on what you are asserting about these rows (why you marked them).' },
        ...SOURCE_PARAM
      },
      additionalProperties: false
    }
  },
  {
    name: 'record_event',
    description:
      'Record an EVENT — an action that transpired on the system (a TTP: e.g. "Microsoft Defender disabled", "AnyDesk remote-access installed", "RDP logon from 1.2.3.4", "PowerShell encoded command executed"). Events are the source of truth for the investigation and the NODES of the Artifact Constellation the analyst reviews. You MUST supply the evidence: the specific rows that corroborate the event happened — and CORROBORATE ACROSS ARTIFACTS, not just the one source that first flagged it. A real action leaves traces in several artifacts (execution → Amcache/Prefetch/AppCompatCache/ShimCache; file create/delete → MFT/USNJRNL; persistence → registry Run keys/scheduled tasks/LNK/startup; remote access → security/RDP logs); before recording, run find_rows for the event\'s key artifact across the OTHER loaded sources and include every source where it actually appears. Evidence MERGES across calls — you can record the event, then call again with the same label to add corroborating evidence from more sources. The tool validates each piece (runs the search in that source) and only records evidence that matches real rows. Optionally attribute a MITRE ATT&CK technique. Use this for the actions/activity you conclude occurred — NOT for raw indicators by themselves.',
    parameters: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Short title of the action/event (e.g. "AnyDesk remote-access installed").' },
        description: { type: 'string', description: 'What happened and why it matters.' },
        technique: { type: 'string', description: 'Optional MITRE ATT&CK technique id or name (e.g. "T1562.001" or "Impair Defenses: Disable or Modify Tools").' },
        users: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional: the user account(s) this event INVOLVES, when the rows make it evident (e.g. ["DESKTOP6\\\\jsmith"] for a logon or a process run as that account). Populates the Timeline\'s User column. Omit when no account is involved or attribution is ambiguous — do not guess.'
        },
        evidence: {
          type: 'array',
          description:
            'The rows that corroborate the event — one item per piece of evidence. Each item: {source, and ONE of value | search | filters, why?}. At least one must validate (match ≥1 row) or the event is not recorded.',
          items: {
            type: 'object',
            properties: {
              source: { type: 'string', description: 'Source/artifact name (from list_sources) the evidence is in.' },
              value: { type: 'string', description: 'A value to match in that source (whole-token for IPs/hashes).' },
              search: { type: 'string', description: 'A contains term across all columns (alternative to value).' },
              filters: { type: 'array', items: { type: 'object' }, description: 'Structured filters (alternative to value/search).' },
              column: { type: 'string', description: 'SCOPE a `value` match to one column (id or label) — e.g. match "Splashtop" only in the FileName column, not every row mentioning it.' },
              time_from: { type: 'string', description: 'SCOPE evidence to rows at/after this time (ISO or epoch). Pin a keyword to the relevant window so the entry is precise, not every historical hit.' },
              time_to: { type: 'string', description: 'SCOPE evidence to rows at/before this time (ISO or epoch).' },
              time_column: { type: 'string', description: 'Which time column the timeline uses for this evidence AND the time_from/time_to window anchors on (e.g. for MFT, "Modified" for execution vs "Created" for a drop). Required for time_from/time_to when the source has more than one time column. Omit (no window) to span all the source\'s time columns.' },
              why: { type: 'string', description: 'Why these rows evidence the event.' }
            }
          }
        }
      },
      required: ['label', 'evidence'],
      additionalProperties: false
    }
  },
  {
    name: 'record_ioc',
    description:
      'Catalog an indicator of compromise (IOC) you encounter during the investigation, with its TYPE from the fixed taxonomy. This builds the case IOC list. It does NOT send anything to the Intel/enrichment grid — sending an (enrichable) IOC there is a deliberate human decision. Types — Primary: ip, domain, url, email, hash; Secondary: filename, filepath, process, commandline, useragent, cloud; Tertiary: registry, service, scheduledtask, mutex, namedpipe, tlsfingerprint, certificate, pdbpath. Pick the most specific type.',
    parameters: {
      type: 'object',
      properties: {
        value: { type: 'string', description: 'The indicator value.' },
        type: {
          type: 'string',
          enum: ['ip', 'domain', 'url', 'email', 'hash', 'filename', 'filepath', 'process', 'commandline', 'useragent', 'cloud', 'registry', 'service', 'scheduledtask', 'mutex', 'namedpipe', 'tlsfingerprint', 'certificate', 'pdbpath'],
          description: 'The IOC type from the taxonomy.'
        },
        context: { type: 'string', description: 'Optional: where/why you saw it (e.g. "C2 from PowerShell beacon in Hayabusa").' }
      },
      required: ['value', 'type'],
      additionalProperties: false
    }
  },
  {
    name: 'list_events',
    description:
      'Read back the events (Artifact Constellation nodes) you have recorded so far — each with its label, ATT&CK technique, the user account(s) it involves (`users`), how many distinct sources corroborate it, and its TIMING: an overall `timeSpan` (UTC start/end across the evidence) plus `times`, the per-timestamp-KIND spans (e.g. Created vs Modified kept distinct, ISO-8601 UTC). Use it to (a) AUDIT coverage — spot events citing only 1–2 sources that still need cross-artifact corroboration, or events that involve an account but have an empty `users` you could attribute — and (b) build a CHRONOLOGY from recorded data instead of memory: order events by their timeSpan, and pick the relevant kind from `times` (e.g. a binary\'s Modified/execution time vs its Created/drop time). Undated events have timeSpan: null.',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'list_iocs',
    description:
      'Read back the IOC catalog you have built so far — each indicator with its taxonomy type and context. Use it to review what you have collected and avoid duplicates.',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'review_coverage',
    description:
      'Audit TRIAGE COVERAGE: which loaded sources you have examined with a data tool this investigation, and which remain UNTOUCHED (with their row counts and host/group). Triaging a system means accounting for EVERY source — not just the ones a lead surfaced; working lead-to-lead silently drops the rest (a second browser-history export, an execution artifact, a forgotten log), which is exactly where findings get missed. Note: opening a source\'s schema with describe_workspace is NOT examining it — you must actually read its data (get_distinct / find_rows / get_all_rows / query_workspace). Untouched sources are listed biggest-first: a 0-row one can be dismissed with a note; a populated one should be investigated. Call this as you wrap up (the app also reminds you before you conclude). Optionally scope to one or more host/system groups.',
    parameters: {
      type: 'object',
      properties: {
        groups: { type: 'array', items: { type: 'string' }, description: 'Optional: only report coverage for sources in these host/system groups (from list_sources). Omit for all sources.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'update_plan',
    description:
      'Record or update your INVESTIGATION PLAN — the ordered leads/steps you intend to follow, each with a status (pending / active / done). This persists to disk per workspace and is shown back to you at the START of every session, so a timeout, Continue, or restart never loses your plan (think of it as your saved to-do list, like a coding plan). Pass the FULL current list each call — it replaces the stored plan. The analyst can also see and edit this plan in the app, so keep it readable: concise concrete next actions, not prose. Maintain it as you work — mark a step done when finished, the next one active.',
    parameters: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          description: 'The full ordered plan. Each item: {text, status?}. status is one of pending|active|done (default pending).',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'The step / lead (a concrete action).' },
              status: { type: 'string', enum: ['pending', 'active', 'done'], description: 'pending (not started), active (in progress), or done.' }
            },
            required: ['text']
          }
        }
      },
      required: ['steps'],
      additionalProperties: false
    }
  },
  {
    name: 'save_progress',
    description:
      'Save a short PROGRESS NOTE for the investigation — where you are RIGHT NOW: the current lead, your working hypothesis, and the concrete next action. This persists per workspace and is shown back to you when a session resumes, so you can pick up mid-investigation without reconstructing context from the chat. It OVERWRITES the previous note, so keep it current (~1-3 sentences). The analyst can also read and edit it in the app. Save progress before you risk running out of room — e.g. when you near the step limit — so nothing is lost.',
    parameters: {
      type: 'object',
      properties: {
        notes: { type: 'string', description: 'Where the investigation stands now: current lead, hypothesis, next step.' }
      },
      required: ['notes'],
      additionalProperties: false
    }
  },
  {
    name: 'get_distinct',
    description:
      'List the distinct values of one column in a source and how often each occurs (e.g. "what event levels / hosts / signatures are present?"). Use a column `id` (c0, c1, …).',
    parameters: {
      type: 'object',
      properties: {
        col: { type: 'string', description: 'Column id (c0, c1, …) or display label.' },
        limit: { type: 'number', description: 'Max distinct values to return (max 200).' },
        ...SOURCE_PARAM
      },
      required: ['col'],
      additionalProperties: false
    }
  },
  {
    name: 'get_cached_intel',
    description:
      'Look up what is ALREADY known about indicators (IPs, domains, hashes) from the local enrichment cache — no network call, no quota spent. Returns cached provider results (e.g. VirusTotal verdict, GeoIP). If an indicator is not cached it is simply absent; to fetch fresh intel you must ask the user (a future capability).',
    parameters: {
      type: 'object',
      properties: {
        indicators: { type: 'array', items: { type: 'string' }, description: 'Indicator values to read from cache.' }
      },
      required: ['indicators'],
      additionalProperties: false
    }
  },
  {
    name: 'classify_indicator',
    description: 'Classify a single string into an indicator kind: ipv4, ipv6, domain, url, email, md5, sha1, sha256, or null if it is none.',
    parameters: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false
    }
  }
]

const KNOWN_TOOLS = new Set(TOOL_DEFS.map((t) => t.name))

// ---- Executor ----

export async function runTool(name: string, rawArgs: unknown, ws: WsCtx, deps?: ToolDeps, coverage?: CoverageTracker): Promise<ToolOutcome> {
  const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>
  // Record that the agent deliberately investigated a SPECIFIC source's data (drives triage-coverage).
  // Only SOURCE-TARGETED reads count (query_workspace/find_rows/get_distinct/get_all_rows + the
  // tag/mark/record-evidence actions). Two things are deliberately NOT examination:
  //   • describe_workspace — reading a schema is not investigating the artifact.
  //   • the fan-out tools (find_in_all_sources/find_around_time) — searching every source for one
  //     value is a DISCOVERY pivot, not per-source triage; a source returning no (or one) hit to a
  //     workspace-wide search has not been opened and read. The agent must follow a fan-out lead with
  //     a source-targeted read to actually examine that source.
  const examined = (sourceId: number): void => {
    coverage?.examined.add(sourceId)
  }
  switch (name) {
    case 'list_sources': {
      if (!ws.hasWorkspace || ws.sources.length === 0) {
        return { result: { hasWorkspace: false, sources: [] }, card: 'list_sources → no workspace open' }
      }
      // `path` is the source's "Group/name" identity (a folder/file address); `id` is its absolute
      // numeric handle. Pass either as a tool's `source` argument — needed when groups share a filename.
      const sources = ws.sources.map((s) => ({ id: s.sourceId, name: s.name, path: pathOf(s), rowCount: s.rowCount, columns: s.columns.length, group: s.group ?? null, active: s.sourceId === ws.activeSourceId }))
      // Group summary: the files in each grouping (host/system/origin), ungrouped bucket last.
      const byGroup = new Map<string | null, string[]>()
      for (const s of ws.sources) {
        const g = s.group ?? null
        if (!byGroup.has(g)) byGroup.set(g, [])
        byGroup.get(g)!.push(s.name)
      }
      const groups = [...byGroup.entries()]
        .sort((a, b) => (a[0] === null ? 1 : b[0] === null ? -1 : 0))
        .map(([group, names]) => ({ group, sources: names }))
      const namedGroups = groups.filter((g) => g.group !== null).length
      return {
        result: { workspace: ws.workspaceName ?? null, sources, groups },
        card: `list_sources → ${sources.length} source(s)${namedGroups ? `, ${namedGroups} group(s)` : ''}`
      }
    }

    case 'describe_workspace': {
      const src = resolveSource(ws, args.source)
      const columns = src.columns.map((c) => ({ id: c.name, label: c.original, ...(c.time ? { time: c.time } : {}) }))
      return {
        result: { source: src.name, rowCount: src.rowCount, columns },
        card: `described "${src.name}" — ${src.rowCount} rows, ${columns.length} cols`
      }
    }

    case 'query_workspace': {
      const src = resolveSource(ws, args.source)
      examined(src.sourceId)
      const filters = normalizeFilters(resolveFilterCols(args.filters, src.columns) as never)
      const search = typeof args.search === 'string' && args.search.trim() ? args.search.trim() : undefined
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), SAMPLE_CAP)

      // Exact match count only when constrained; an unconstrained query is just the source row count.
      let matchCount: number | null
      if (filters || search) {
        matchCount = await dbw.count(src.tabId, reqSeq++, filters, search ?? '', () => {})
      } else {
        matchCount = src.rowCount
      }

      const page = (await dbw.call('queryRows', src.tabId, normalizeOpts({ filters, search, limit, offset: 0 } as never))) as {
        rows: string[][]
        rids: number[]
      }
      const sample = (page.rows ?? []).map((r) => rowToObject(r, src.columns))
      return {
        result: { source: src.name, matchCount, sampleSize: sample.length, sample },
        card: `query_workspace [${src.name}] → ${matchCount ?? '?'} rows match`
      }
    }

    case 'find_rows': {
      const src = resolveSource(ws, args.source)
      const value = String(args.value ?? '').trim()
      if (!value) return { result: { matchCount: 0, sample: [], note: 'empty value' }, card: 'find_rows → empty value' }
      examined(src.sourceId)
      const timeFilters = timeWindowFilter(src, args)
      const m = await findMatches(src, value, args.column, timeFilters)

      // Count is exact for substring kinds; for whole-token kinds it's exact only when the full
      // candidate set fit under the cap (otherwise we only token-filtered the first page).
      let matchCount: number | null
      let note: string | undefined
      if (m.matchType === 'contains') matchCount = m.substringCount
      else if (m.complete) matchCount = m.rids.length
      else {
        matchCount = null
        note = `Too many candidates to token-filter exactly (>${CANDIDATE_CAP}); showing a token-exact sample. Substring matches: ${m.substringCount}.`
      }

      const sample = m.rows.slice(0, SAMPLE_CAP).map((r) => rowToObject(r, src.columns))
      const timed = timeFilters.length > 0
      return {
        result: { source: src.name, value, matchType: m.matchType, ...(m.colLabel ? { column: m.colLabel } : {}), ...(timed ? { timeWindowApplied: true } : {}), matchCount, sampleSize: sample.length, sample, ...(note ? { note } : {}) },
        card: `find_rows [${src.name}] "${value}"${timed ? ' (timed)' : ''} → ${matchCount ?? `${m.rids.length}+`} match${matchCount === 1 ? '' : 'es'}`
      }
    }

    case 'find_in_all_sources': {
      if (!ws.hasWorkspace || ws.sources.length === 0) throw new Error('No workspace is open.')
      const value = String(args.value ?? '').trim()
      if (!value) return { result: { value: '', perSource: [], note: 'empty value' }, card: 'find_in_all_sources → empty value' }
      const ALL_SAMPLE = Math.min(Math.max(Number(args.sample) || 3, 1), 15) // per-source sample (model can raise it for structured artifacts)
      const { sources: scope, scopedTo } = scopedSources(ws.sources, args.groups)
      if (scopedTo && scope.length === 0) {
        return { result: { value, scope: scopedTo, perSource: [], note: `No loaded source is in group(s): ${scopedTo.join(', ')}. Check list_sources for the exact group labels.` }, card: `find_in_all_sources "${value}" → no sources in ${scopedTo.join(', ')}` }
      }
      const perSource: Array<{ source: string; matchCount: number; sampleSize: number; sample: Record<string, string>[] }> = []
      // Cheap path: a CONTAINS count per source (no candidate pull) + a tiny sample. Precise whole-token
      // counts are the job of find_rows on a specific source; here we just locate where the value occurs.
      for (const src of scope) {
        const matchCount = (await dbw.count(src.tabId, reqSeq++, undefined, value, () => {})) ?? 0
        if (matchCount === 0) continue
        const page = (await dbw.call('queryRows', src.tabId, normalizeOpts({ search: value, limit: ALL_SAMPLE, offset: 0 } as never))) as { rows: string[][] }
        const sample = (page.rows ?? []).map((r) => rowToObject(r, src.columns))
        perSource.push({ source: src.name, matchCount, sampleSize: sample.length, sample })
      }
      perSource.sort((a, b) => b.matchCount - a.matchCount)
      return {
        result: { value, scope: scopedTo ?? 'all sources', sourcesSearched: scope.length, sourcesWithMatches: perSource.length, matchType: 'contains', perSource },
        card: `find_in_all_sources "${value}"${scopedTo ? ` [${scopedTo.join(', ')}]` : ''} → ${perSource.length}/${scope.length} source(s) hit`
      }
    }

    case 'get_all_rows': {
      const src = resolveSource(ws, args.source)
      const FULL_READ_CAP = 200 // small enough to return whole; larger sources must be queried/searched
      const FULL_CELL_CAP = 1000 // fuller cells than the default sample clip — these artifacts' content IS the point
      if (src.rowCount > FULL_READ_CAP) {
        return {
          result: { source: src.name, rowCount: src.rowCount, rows: [], note: `"${src.name}" has ${src.rowCount} rows (> ${FULL_READ_CAP}) — too large to read in full. Use find_rows or query_workspace to target the rows you need.` },
          card: `get_all_rows [${src.name}] → too large (${src.rowCount} rows)`
        }
      }
      examined(src.sourceId)
      const page = (await dbw.call('queryRows', src.tabId, normalizeOpts({ limit: FULL_READ_CAP, offset: 0 } as never))) as { rows: string[][] }
      const rows = (page.rows ?? []).map((r) => rowToObject(r, src.columns, FULL_CELL_CAP))
      return { result: { source: src.name, rowCount: src.rowCount, rowsReturned: rows.length, rows }, card: `get_all_rows [${src.name}] → ${rows.length} row(s)` }
    }

    case 'find_around_time': {
      if (!ws.hasWorkspace || ws.sources.length === 0) throw new Error('No workspace is open.')
      const anchor = toEpochSeconds(args.timestamp)
      if (anchor == null) throw new Error('find_around_time needs a parseable timestamp — use ISO (e.g. 2026-06-13T17:09:02Z) or epoch seconds.')
      const within = Math.max(1, Math.trunc(Number(args.within_sec) || 60))
      const from = anchor - within
      const to = anchor + within
      const value = String(args.value ?? '').trim()
      const ALL_SAMPLE = 3
      const { sources: scope, scopedTo } = scopedSources(ws.sources, args.groups)
      if (scopedTo && scope.length === 0) {
        return { result: { anchor: String(args.timestamp), scope: scopedTo, perSource: [], note: `No loaded source is in group(s): ${scopedTo.join(', ')}.` }, card: `find_around_time → no sources in ${scopedTo.join(', ')}` }
      }
      const perSource: Array<{ source: string; timeColumn: string; matchCount: number; sampleSize: number; sample: Record<string, string>[] }> = []
      const skipped: Array<{ source: string; reason: string }> = []
      for (const src of scope) {
        const cols = timeColumnsOf(src)
        if (cols.length === 0) {
          skipped.push({ source: src.name, reason: 'no time column' })
          continue
        }
        if (cols.length > 1) {
          skipped.push({ source: src.name, reason: `multiple time columns (${cols.map((c) => `${c.label}=${c.id}`).join(', ')}) — use find_rows with time_from/time_to + time_column` })
          continue
        }
        const tc = cols[0]
        const filters = normalizeFilters([{ col: tc.id, op: 'timerange', tkind: tc.kind, from, to }] as never)
        const search = value || undefined
        const matchCount = (await dbw.count(src.tabId, reqSeq++, filters, search ?? '', () => {})) ?? 0
        if (matchCount === 0) continue
        const page = (await dbw.call('queryRows', src.tabId, normalizeOpts({ filters, search, limit: ALL_SAMPLE, offset: 0 } as never))) as { rows: string[][] }
        const sample = (page.rows ?? []).map((r) => rowToObject(r, src.columns))
        perSource.push({ source: src.name, timeColumn: tc.label, matchCount, sampleSize: sample.length, sample })
      }
      perSource.sort((a, b) => b.matchCount - a.matchCount)
      return {
        result: { anchor: String(args.timestamp), withinSec: within, scope: scopedTo ?? 'all sources', value: value || null, sourcesWithMatches: perSource.length, perSource, ...(skipped.length ? { skipped } : {}) },
        card: `find_around_time ±${within}s${scopedTo ? ` [${scopedTo.join(', ')}]` : ''} → ${perSource.length} source(s) hit`
      }
    }

    case 'tag_rows': {
      const src = resolveSource(ws, args.source)
      examined(src.sourceId)
      if (ws.wsId == null) throw new Error('This workspace cannot be tagged (no workspace id).')
      if (!deps?.requestApproval) throw new Error('Tagging needs user confirmation, which is unavailable in this run.')
      const tag = normalizeTag(args.tag)
      if (!tag) throw new Error('Invalid tag. Use one of: Malicious, Suspicious, Unknown, Benign.')
      const value = String(args.value ?? '').trim()

      // Two targeting modes: by value (precise, rid-based) or by structured filters/search.
      if (value) {
        const m = await findMatches(src, value, args.column)
        const exact = m.complete ? `${m.rids.length}` : `${m.rids.length}+ (capped at ${CANDIDATE_CAP})`
        const where = m.colLabel ? ` in ${m.colLabel}` : ''
        const approved = await deps.requestApproval({
          kind: 'tag',
          tag,
          count: m.rids.length,
          summary: `Tag ${exact} row(s) containing "${value}"${where} in ${src.name} as ${tagLabel(tag)}`,
          detail: benignNote(tag) + (m.matchType === 'whole-token' ? 'Whole-token match (IPs/hashes).' : 'Substring match.')
        })
        if (!approved) return { result: { tagged: 0, declined: true }, card: `tag_rows → declined` }
        await dbw.call('setTags', ws.wsId, src.sourceId, m.rids, tag, 'ai')
        await dbw.call('setAiMarks', ws.wsId, src.sourceId, m.rids, `Tagged ${tagLabel(tag)}`) // also ✨-mark (AI assertion)
        return { result: { tagged: m.rids.length, tag, value, source: src.name, attributedTo: 'ai', complete: m.complete }, card: `tag_rows [${src.name}] → tagged ${m.rids.length} as ${tagLabel(tag)}` }
      }

      // Filter/search mode — tags the whole match set (substring), not just a page.
      const filters = normalizeFilters(resolveFilterCols(args.filters, src.columns) as never)
      const search = typeof args.search === 'string' && args.search.trim() ? args.search.trim() : undefined
      if (!filters && !search) throw new Error('Provide a value, or filters/search, to choose which rows to tag.')
      const count = (await dbw.count(src.tabId, reqSeq++, filters, search ?? '', () => {})) ?? 0
      const approved = await deps.requestApproval({ kind: 'tag', tag, count, summary: `Tag ${count} row(s) in ${src.name} matching the current criteria as ${tagLabel(tag)}`, detail: benignNote(tag) || undefined })
      if (!approved) return { result: { tagged: 0, declined: true }, card: `tag_rows → declined` }
      const res = (await dbw.call('tagByFilter', ws.wsId, src.sourceId, filters, search, tag, 'ai')) as { count: number }
      await dbw.call('aiMarkByFilter', ws.wsId, src.sourceId, filters, search, `Tagged ${tagLabel(tag)}`) // also ✨-mark
      return { result: { tagged: res.count, tag, source: src.name, attributedTo: 'ai' }, card: `tag_rows [${src.name}] → tagged ${res.count} as ${tagLabel(tag)}` }
    }

    case 'set_source_group': {
      const src = resolveSource(ws, args.source)
      if (ws.wsId == null) throw new Error('This workspace cannot be grouped (no workspace id).')
      if (!deps?.requestApproval) throw new Error('Grouping needs user confirmation, which is unavailable in this run.')
      const group = typeof args.group === 'string' && args.group.trim() ? args.group.trim().slice(0, 120) : null
      const prev = src.group ?? null
      if (group === prev) {
        return { result: { changed: false, source: src.name, group, reason: 'already in this group' }, card: `set_source_group [${src.name}] → already ${group ?? 'ungrouped'}` }
      }
      const summary = group
        ? `Group source "${src.name}" as ${group}${prev ? ` (was ${prev})` : ''}`
        : `Remove source "${src.name}" from its group${prev ? ` (${prev})` : ''}`
      const approved = await deps.requestApproval({ kind: 'group', sourceId: src.sourceId, group, summary, detail: 'Sets the host/system this artifact is attributed to (the Timeline\'s Host).' })
      if (!approved) return { result: { changed: false, declined: true, source: src.name }, card: `set_source_group → declined` }
      await dbw.call('setSourceGroup', ws.wsId, src.sourceId, group)
      src.group = group // mirror into this run's context so later tools (list_sources) see it immediately
      return { result: { changed: true, source: src.name, group, previous: prev }, card: `set_source_group [${src.name}] → ${group ?? 'ungrouped'}` }
    }

    case 'mark_rows': {
      const src = resolveSource(ws, args.source)
      examined(src.sourceId)
      if (ws.wsId == null) throw new Error('This workspace cannot be marked (no workspace id).')
      const note = typeof args.note === 'string' && args.note.trim() ? args.note.trim().slice(0, 300) : null
      const value = String(args.value ?? '').trim()
      if (value) {
        const m = await findMatches(src, value, args.column)
        if (m.rids.length === 0) return { result: { marked: 0, value, source: src.name }, card: `mark_rows [${src.name}] "${value}" → no matches` }
        const res = (await dbw.call('setAiMarks', ws.wsId, src.sourceId, m.rids, note)) as { count: number }
        return { result: { marked: res.count, value, note, source: src.name }, card: `✨ marked ${res.count} row(s) in ${src.name} for "${value}"` }
      }
      const filters = normalizeFilters(resolveFilterCols(args.filters, src.columns) as never)
      const search = typeof args.search === 'string' && args.search.trim() ? args.search.trim() : undefined
      if (!filters && !search) throw new Error('Provide a value, or filters/search, to choose which rows to mark.')
      const res = (await dbw.call('aiMarkByFilter', ws.wsId, src.sourceId, filters, search, note)) as { count: number }
      return { result: { marked: res.count, note, source: src.name }, card: `✨ marked ${res.count} row(s) in ${src.name}` }
    }

    case 'record_event': {
      if (!ws.hasWorkspace || ws.wsId == null || ws.sources.length === 0) throw new Error('No workspace is open.')
      const label = typeof args.label === 'string' && args.label.trim() ? args.label.trim().slice(0, 200) : ''
      if (!label) throw new Error('record_event needs a label (the action/event that occurred).')
      const description = typeof args.description === 'string' && args.description.trim() ? args.description.trim().slice(0, 600) : null
      // Ground the cited technique against the ATT&CK catalog (canonicalize known ones; keep + flag unknown).
      const rawTechnique = typeof args.technique === 'string' && args.technique.trim() ? args.technique.trim().slice(0, 160) : null
      const resolvedTechnique = rawTechnique ? resolveTechnique(rawTechnique) : null
      const technique = resolvedTechnique ? resolvedTechnique.display : null
      // Curated user attribution — only set when the model supplied it (undefined leaves any prior set
      // untouched on a merge-re-record; the db normalizes/dedups/caps).
      const users = Array.isArray(args.users) ? args.users.map((u) => String(u ?? '').trim()).filter(Boolean) : undefined
      const items = Array.isArray(args.evidence) ? (args.evidence as Array<Record<string, unknown>>) : []
      if (items.length === 0) throw new Error('record_event needs evidence (the rows that corroborate the event).')

      // Validate each evidence item against the data; only what really matches is kept + ✨-marked.
      // Items that match 0 rows (or can't resolve their source) are dropped, but we report WHY in
      // `rejected` so the model can fix the search/source/column and retry instead of guessing.
      const evidence: Array<{ sourceId: number; sourceName: string; matched: string; count: number; rids: number[]; spans: ColSpan[]; tsMin: number | null; tsMax: number | null }> = []
      const rejected: Array<{ source: unknown; matched?: string; reason: string }> = []
      for (const item of items) {
        let src: WsSource
        try {
          src = resolveSource(ws, item.source)
        } catch (e) {
          rejected.push({ source: item.source ?? '(none)', reason: e instanceof Error ? e.message : String(e) })
          continue
        }
        examined(src.sourceId) // validating evidence against a source counts as examining it
        // Optional scoping so a broad keyword doesn't attach hundreds of unrelated rows: a column to
        // match in, and/or a time window (time_from/time_to anchored on time_column). A value like
        // "Splashtop" otherwise matches every related MFT record — scoping pins it to the real rows.
        let windowFilter: unknown[]
        try {
          windowFilter = timeWindowFilter(src, item)
        } catch (e) {
          rejected.push({ source: src.name, matched: String(item.value ?? item.search ?? 'filter'), reason: e instanceof Error ? e.message : String(e) })
          continue
        }
        const value = String(item.value ?? '').trim()
        let rids: number[] = []
        let rows: string[][] = []
        let count = 0
        let matched = ''
        if (value) {
          const m = await findMatches(src, value, item.column, windowFilter)
          rids = m.rids
          rows = m.rows
          count = m.complete ? m.rids.length : m.substringCount
          matched = value
        } else {
          const base = item.filters ? (resolveFilterCols(item.filters, src.columns) as unknown[]) : []
          const merged = [...(Array.isArray(base) ? base : []), ...windowFilter]
          const filters = merged.length ? normalizeFilters(merged as never) : undefined
          const search = typeof item.search === 'string' && item.search.trim() ? item.search.trim() : undefined
          if (!filters && !search) {
            rejected.push({ source: src.name, reason: 'no value, search, or filters supplied for this evidence item' })
            continue
          }
          count = (await dbw.count(src.tabId, reqSeq++, filters, search ?? '', () => {})) ?? 0
          const page = (await dbw.call('queryRows', src.tabId, normalizeOpts({ filters, search, limit: CANDIDATE_CAP, offset: 0 } as never))) as { rids: number[]; rows: string[][] }
          rids = page.rids ?? []
          rows = page.rows ?? []
          matched = search ?? 'filter'
        }
        if (rids.length === 0) {
          rejected.push({ source: src.name, matched: matched || value, reason: `matched 0 rows in ${src.name} — check the search term, source, or column` })
          continue
        }
        // Capture the evidence's time spans — one per time column (Created vs Modified kept distinct),
        // or just item.time_column when given. These feed the Timeline (one row per kind); the envelope
        // is the whole-evidence span for the constellation axis. Empty spans = undated evidence.
        const spans = spansByColumn(src, rows, item.time_column)
        const { tsMin, tsMax } = envelopeOf(spans)
        // The rows we STORE as evidence are the same rows the Timeline shows and a pivot lands on — so
        // ✨-mark EXACTLY those (not a different, larger set), and label the mark "Timeline evidence: …"
        // so the analyst can see why a row is marked: it backs this event on the Timeline.
        const storedRids = rids.slice(0, EVIDENCE_RID_CAP)
        evidence.push({ sourceId: src.sourceId, sourceName: src.name, matched, count, rids: storedRids, spans, tsMin, tsMax })
        await dbw.call('setAiMarks', ws.wsId, src.sourceId, storedRids, `Timeline evidence: ${label}`)
      }

      if (evidence.length === 0) {
        return {
          result: { recorded: false, label, reason: 'None of the evidence matched any rows — event not recorded (it must be backed by real rows). See `rejected` for why each item failed, then fix and retry.', rejected },
          card: `record_event "${label}" → no evidence matched (not recorded)`
        }
      }

      const id = `event:${label.toLowerCase().replace(/\s+/g, '-').slice(0, 80)}`
      await dbw.call('recordEvent', ws.wsId, { id, label, description, technique, users }, evidence)
      if (coverage) coverage.recordedEvents++ // a concluded event marks this run as a triage (drives coverage nudges)

      // Read back the event's CUMULATIVE evidence (this call is additive/merged), so coverage reflects
      // everything corroborating the event so far — not just this call's pieces.
      const allEvents = (await dbw.call('listEvents', ws.wsId)) as Array<{ id: string; evidence: Array<{ sourceId: number; sourceName: string }> }>
      const thisEvent = allEvents.find((e) => e.id === id)
      const citedIds = new Set((thisEvent?.evidence ?? evidence).map((e) => e.sourceId))
      const sources = [...new Set((thisEvent?.evidence ?? evidence).map((e) => e.sourceName))]

      // Coverage nudge: forensic events usually leave traces across MANY artifacts. We can't know how
      // many an event SHOULD touch, so the stop point scales with how many sources are loaded — keep
      // nudging until the event cites ~a quarter of them (floored at 2 so tiny workspaces aren't nagged,
      // and never nudging past what's actually un-cited). Below that, name the un-cited sources so the
      // model corroborates there (or confirms it checked and they're clean) and calls record_event again.
      const uncited = ws.sources.filter((s) => !citedIds.has(s.sourceId)).map((s) => s.name)
      const corroborationTarget = Math.max(2, Math.ceil(ws.sources.length / 4))
      const corroboration =
        uncited.length > 0 && citedIds.size < corroborationTarget
          ? `This event cites ${citedIds.size} of ${ws.sources.length} loaded sources. A real action usually leaves corroborating traces across several artifacts (execution → Amcache/Prefetch/AppCompatCache/ShimCache; file create/delete → MFT/USNJRNL; persistence → registry Run keys/scheduled tasks/LNK/startup; remote access → security/RDP logs). Use find_rows to look for this event's key artifact in the un-cited sources where it would plausibly appear, then call record_event again with the same label to add that evidence (it merges, it does not overwrite). It's fine to stop once you've genuinely checked the relevant artifacts — not every event lives in every source. Un-cited sources: ${uncited.slice(0, 30).join(', ')}.`
          : undefined

      // Wide-evidence nudge: an evidence item matching many rows means the Timeline entry represents ALL
      // of them (and a pivot lands on all), with the displayed time just the earliest. Tell the model so
      // it re-records with tighter scoping (column / time_from-to / an exact path) for a precise entry.
      const WIDE = 25
      const wide = evidence.filter((e) => e.count > WIDE).map((e) => `"${e.matched}" in ${e.sourceName} → ${e.count} rows`)
      const wideEvidence =
        wide.length > 0
          ? `Some evidence matched MANY rows, so that Timeline entry represents all of them at once (the shown time is just the earliest): ${wide.join('; ')}. Re-record those with tighter scoping — a column, a time_from/time_to window, or an exact path/value — so each entry pins to the specific rows.`
          : undefined

      return {
        result: { recorded: true, label, technique, techniqueVerified: resolvedTechnique?.verified ?? null, evidenceCount: thisEvent?.evidence.length ?? evidence.length, sources, ...(rejected.length ? { rejected } : {}), ...(wideEvidence ? { wideEvidence } : {}), ...(corroboration ? { corroboration } : {}) },
        card: `★ event "${label}"${resolvedTechnique ? ` [${resolvedTechnique.id ?? rawTechnique}]` : ''} — ${sources.length} source(s)${rejected.length ? ` · ${rejected.length} evidence rejected` : ''}`
      }
    }

    case 'record_ioc': {
      if (!ws.hasWorkspace || ws.wsId == null) throw new Error('No workspace is open.')
      const value = String(args.value ?? '').trim()
      if (!value) throw new Error('record_ioc needs a value.')
      const type = normalizeIocType(args.type)
      if (!type) throw new Error(`Invalid IOC type. Use one of: ${Object.keys(IOC_TYPES).join(', ')}.`)
      const context = typeof args.context === 'string' && args.context.trim() ? args.context.trim().slice(0, 300) : null
      const id = `${type}:${value.toLowerCase()}`
      await dbw.call('recordIoc', ws.wsId, { id, value, type, context })
      return { result: { recorded: true, value, type, context, note: 'Catalogued. Not sent to the Intel grid — the analyst decides that.' }, card: `⊕ IOC [${IOC_TYPES[type]}] ${value}` }
    }

    case 'list_events': {
      if (!ws.hasWorkspace || ws.wsId == null) throw new Error('No workspace is open.')
      const events = (await dbw.call('listEvents', ws.wsId)) as Array<{
        label: string
        description: string | null
        technique: string | null
        users?: string[]
        evidence: Array<{ sourceName: string; tsMin: number | null; tsMax: number | null; spans?: Array<{ kind: string; tsMin: number; tsMax: number }> }>
      }>
      const items = events.map((e) => {
        const sources = [...new Set(e.evidence.map((v) => v.sourceName))]
        // Overall epoch-second envelope across the event's evidence (null = undated).
        let lo: number | null = null
        let hi: number | null = null
        for (const v of e.evidence) {
          if (v.tsMin != null && (lo == null || v.tsMin < lo)) lo = v.tsMin
          if (v.tsMax != null && (hi == null || v.tsMax > hi)) hi = v.tsMax
        }
        // Per-timestamp-kind aggregate (Created vs Modified kept distinct) across all evidence — the
        // basis for chronology: each kind is a candidate time for the event on a timeline.
        const byKind = new Map<string, { lo: number; hi: number }>()
        for (const v of e.evidence) {
          for (const s of v.spans ?? []) {
            const cur = byKind.get(s.kind)
            if (!cur) byKind.set(s.kind, { lo: s.tsMin, hi: s.tsMax })
            else byKind.set(s.kind, { lo: Math.min(cur.lo, s.tsMin), hi: Math.max(cur.hi, s.tsMax) })
          }
        }
        const times = [...byKind.entries()].map(([kind, r]) => ({ kind, start: isoUtc(r.lo), end: isoUtc(r.hi) }))
        return {
          label: e.label,
          technique: e.technique,
          users: e.users ?? [],
          sourceCount: sources.length,
          sources,
          evidenceCount: e.evidence.length,
          timeSpan: lo != null && hi != null ? { start: isoUtc(lo), end: isoUtc(hi) } : null,
          times
        }
      })
      return { result: { count: items.length, events: items }, card: `list_events → ${items.length} event(s)` }
    }

    case 'list_iocs': {
      if (!ws.hasWorkspace || ws.wsId == null) throw new Error('No workspace is open.')
      const iocs = (await dbw.call('listIocs', ws.wsId)) as Array<{ value: string; type: string; context: string | null }>
      const items = iocs.map((i) => ({ value: i.value, type: IOC_TYPES[i.type] ?? i.type, context: i.context }))
      return { result: { count: items.length, iocs: items }, card: `list_iocs → ${items.length} IOC(s)` }
    }

    case 'review_coverage': {
      if (!ws.hasWorkspace || ws.sources.length === 0) {
        return { result: { hasWorkspace: false, total: 0, examined: [], untouched: [] }, card: 'review_coverage → no workspace open' }
      }
      const { sources: scoped, scopedTo } = scopedSources(ws.sources, args.groups)
      const universe = coverageUniverse(scoped) // exclude the derived Timeline source
      const seen = coverage?.examined ?? new Set<number>()
      const examinedSrc = universe.filter((s) => seen.has(s.sourceId))
      const untouched = universe.filter((s) => !seen.has(s.sourceId)).sort((a, b) => b.rowCount - a.rowCount)
      return {
        result: {
          scope: scopedTo ?? 'all sources',
          total: universe.length,
          examinedCount: examinedSrc.length,
          untouchedCount: untouched.length,
          examined: examinedSrc.map((s) => s.name),
          untouched: untouched.map((s) => ({ source: s.name, rowCount: s.rowCount, group: s.group ?? null })),
          ...(untouched.length === 0
            ? { complete: true }
            : {
                guidance:
                  'Examine each untouched source (get_distinct / find_rows / get_all_rows / query_workspace) or state why it can be skipped. Triage is not complete until every source is accounted for. Untouched sources are listed biggest-first — a 0-row one is dismissable; a populated one likely holds activity you have not seen.'
              })
        },
        card: `review_coverage → ${examinedSrc.length}/${universe.length} examined${untouched.length ? `, ${untouched.length} untouched` : ' — all covered'}`
      }
    }

    case 'update_plan': {
      if (!ws.hasWorkspace || ws.wsId == null) throw new Error('No workspace is open.')
      const raw = Array.isArray(args.steps) ? (args.steps as Array<Record<string, unknown>>) : []
      const steps = raw
        .map((s) => ({ text: String(s?.text ?? '').trim().slice(0, 500), status: normPlanStatus(s?.status) }))
        .filter((s) => s.text)
      await dbw.call('setInvestigationPlan', ws.wsId, steps)
      const done = steps.filter((s) => s.status === 'done').length
      const active = steps.filter((s) => s.status === 'active').length
      return { result: { saved: true, steps: steps.length, active, done }, card: `update_plan → ${steps.length} step(s) (${done} done${active ? `, ${active} active` : ''})` }
    }

    case 'save_progress': {
      if (!ws.hasWorkspace || ws.wsId == null) throw new Error('No workspace is open.')
      const notes = String(args.notes ?? '').trim().slice(0, 5000)
      await dbw.call('setInvestigationNotes', ws.wsId, notes)
      return { result: { saved: true }, card: `save_progress → progress noted` }
    }

    case 'get_distinct': {
      const src = resolveSource(ws, args.source)
      examined(src.sourceId)
      const col = resolveCol(args.col, src.columns)
      const limit = Math.min(Math.max(Number(args.limit) || 50, 1), DISTINCT_CAP)
      const res = (await dbw.distinct(src.tabId, reqSeq++, col, undefined, limit, () => {})) as {
        rows: Array<{ val: string; cnt: number }>
        total: number
        truncated: boolean
      } | null
      if (!res) return { result: { values: [], total: 0, truncated: false }, card: 'get_distinct → canceled' }
      const label = src.columns.find((c) => c.name === col)?.original ?? col
      return {
        result: { source: src.name, column: label, total: res.total, truncated: res.truncated, values: res.rows.map((r) => ({ value: clip(r.val), count: r.cnt })) },
        card: `get_distinct [${src.name}] ${label} → ${res.total} distinct`
      }
    }

    case 'get_cached_intel': {
      const indicators = Array.isArray(args.indicators) ? args.indicators.map(String).filter(Boolean) : []
      if (indicators.length === 0) return { result: { results: [] }, card: 'get_cached_intel → no indicators' }
      const dbPath = ws.intelDbPath || (await dbw.call<string>('enrichDefaultDb'))
      const rows = (await dbw.call('enrichCacheGet', dbPath, indicators)) as Array<{
        provider: string
        indicator: string
        kind: string
        status: string
        fields: Record<string, string>
        fetchedAt: number
      }>
      const found = new Set(rows.map((r) => r.indicator))
      const uncached = indicators.filter((i) => !found.has(i))
      return {
        result: { results: rows, uncached },
        card: `get_cached_intel → ${rows.length} cached, ${uncached.length} uncached`
      }
    }

    case 'classify_indicator': {
      const value = String(args.value ?? '')
      return { result: { value, kind: classifyIndicator(value) }, card: `classify_indicator "${value}"` }
    }

    default:
      if (!KNOWN_TOOLS.has(name)) throw new Error(`Unknown tool: ${name}`)
      throw new Error(`Tool not implemented: ${name}`)
  }
}
