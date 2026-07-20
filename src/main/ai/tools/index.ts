// The AI toolbox. Each tool maps to an existing deterministic capability so the model is grounded —
// it learns indicators only by calling enrichment, and analyzes the case data only by querying the
// SQL layer (counts + small samples, never raw rows). Phase 1 tools are all read-only ('free');
// gated action tools (apply filter / enrich / tag / sweep) land in a later phase.
//
// Everything runs headless in main through the existing worker proxies (dbClient). Column ids are
// always c<n>, run through the same normalizeFilters/normalizeOpts sanitizer the csv:* IPC uses, so
// a malformed AI filter is rejected at the boundary and never reaches SQL.

import { randomUUID } from 'node:crypto'
import * as dbw from '../../csv/dbClient'
import { classifyEvidence, groupAtDepth, summarizeNotImportable, unsupportedReason, type WalkResult } from '../../csv/evidence'
// Type-only: db.ts pulls in better-sqlite3, so this import must never emit a runtime require here
// (the tools reach the DB exclusively through the worker via dbClient).
import type { WorkspaceEntry } from '../../csv/db'
import { normalizeFilters, normalizeOpts } from '../../csv/ipc'
import { runAgentSql } from '../../csv/sqlClient'
import { checkAgentSql } from '../../csv/sqlGuard'
import { compileIntel, matchText, type SweepKind } from '../../csv/sweep'
import type { Sort, TimeBucket } from '../../csv/sql'
import { ATTACK_VERSION, resolveTechnique } from '../attack'
import { classifyIndicator } from '../classify'
import { IOC_TYPES, normalizeIocType } from '../../../shared/iocTypes'
import { TAG_IDS, TAG_LABELS, type TagId } from '../../../shared/tags'
import { AGENT_SETTABLE_STATUSES, aliasSuggestion, entityId } from '../../../shared/entities'
import type { EntityOut as CsvEntityOut } from '../../csv/entityDerive'
import type { CaseReportItem, NegativeOut } from '../../csv/db'
import { corroborationCandidates } from '../corroborate'
import { coverageUniverse } from '../coverage'
import { resolveCol, resolveFilterCols, timeFilterProblem } from '../colmap'
import { pathOf, resolveSource } from '../sources'
import { envelopeOf, implausibleSpans, resolveTimeColumn, spansByColumn, timeColumnsOf, toEpochSeconds, type ColSpan } from '../timecols'
import type { AiTool, CoverageTracker, ToolDeps, WsColumn, WsCtx, WsSource } from '../types'

// The standard `source` param (every data tool accepts it; defaults to the on-screen source).
const SOURCE_PARAM = {
  source: {
    type: 'string',
    description:
      'Which source/artifact to target. Accepts a name, a group-qualified path "Group/name" (e.g. "HOST-A/hayabusa_events_offline.csv"), or the numeric id from list_sources. Use the PATH or id when multiple hosts share a filename — a bare colliding name is rejected. Omit to use the source currently on screen.'
  }
} as const

// Persisted intent-tag ids — MUST match the renderer's TagId (state/tags.ts), which is lowercase.
// The grid looks tags up by these ids, so storing a different case wouldn't render.
const TAG_VALUES = TAG_IDS
type TagValue = TagId
// Loose synonyms so a model phrasing ("bad", "clean", "flag as threat") still maps to a valid tag.
const TAG_SYNONYMS: Record<string, TagValue> = {
  bad: 'malicious', evil: 'malicious', threat: 'malicious', malware: 'malicious', compromised: 'malicious', flagged: 'malicious',
  suspect: 'suspicious', anomalous: 'suspicious',
  clean: 'benign', safe: 'benign', good: 'benign', legit: 'benign', legitimate: 'benign', normal: 'benign',
  unsure: 'unknown', unclear: 'unknown', unverified: 'unknown'
}
const tagLabel = (id: string): string => TAG_LABELS[id as TagId] ?? id
// Benign is the analyst's call, not the AI's — surface a reminder on its confirm card.
const benignNote = (tag: string): string => (tag === 'benign' ? '⚠ Benign is the analyst’s determination — confirm only if you agree. ' : '')

/** The SQL table backing a source. tabId is `${wsId}:${sourceId}`; the table is `data_<sourceId>`. */
const tableOf = (src: WsSource): string => `data_${src.sourceId}`

/** Leaf name of an evidence-relative path (always '/'-style from list_evidence, but tolerate '\'). */
const baseName = (rel: string): string => rel.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? rel

const SAMPLE_CAP = 25 // max rows returned to the model from query_workspace / find_rows
const CELL_CAP = 200 // max chars per cell in a sample (keeps token use bounded)
// Agent SQL is bounded hard, because the query shape is arbitrary. The row cap keeps a listing from
// flooding the caller's context; the deadline stops a query still PRODUCING rows; the kill covers
// what neither can see — SQLite materializes an ORDER BY/GROUP BY inside one native call that cannot
// be interrupted, which is exactly why this runs on its own thread.
// A row is "wide" past this, and a cell this long is "bulky" — the two together decide the default
// projection. Tuned so an EvtxECmd Payload (event XML) is dropped while ordinary artifact columns,
// including long file paths and command lines, are kept.
const WIDE_ROW_COLS = 8
const BULKY_CELL_CHARS = 300

const SQL_ROW_CAP = 200
const SQL_DEADLINE_MS = 15_000
const SQL_KILL_MS = 30_000
const DISTINCT_CAP = 200
const CANDIDATE_CAP = 2000 // find_rows: substring candidates pulled back for whole-token filtering
const EVIDENCE_RID_CAP = 500 // record_event: max rowids stored per evidence item (the pivot lands on these exact rows)
const AGG_CAP = 500
// Longest statement record_negative/record_lead will accept. Mirrors the same cap in db.ts, which
// keeps its own copy as a backstop — it cannot be imported from there because db.ts pulls in
// better-sqlite3 and this module must stay a TYPE-only consumer of it.
const NEGATIVE_STATEMENT_MAX = 500 // aggregate: max buckets returned
const TIME_BUCKETS = new Set<TimeBucket>(['minute', 'hour', 'day', 'month', 'year', 'hourofday', 'dayofweek'])

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
function rowToObject(cells: string[], columns: WsColumn[] | undefined, cap: number = CELL_CAP, pick?: Set<number>): Record<string, string> {
  const out: Record<string, string> = {}
  cells.forEach((cell, i) => {
    if (pick && !pick.has(i)) return // column projection: only the requested columns (cuts token cost)
    const label = columns?.[i]?.original ?? `c${i}`
    out[label] = clipTo(cell ?? '', cap)
  })
  return out
}

/**
 * Columns to leave OUT of a sample by default, because they are enormous and usually not what was
 * asked about.
 *
 * One find_rows for an event id returned 25 rows x 27 columns of mostly-JSON: EvtxECmd's `Payload`
 * carries the whole event XML, so the useful fields are buried in a payload that costs more tokens
 * than the entire rest of the answer. The `columns` parameter already solved this — but the DEFAULT
 * was the expensive one, on exactly the tools most likely to be aimed at a 195k-row event log.
 *
 * Only ever a DEFAULT: an explicit `columns` request wins, and every omission is named in the result
 * so the caller can ask for it. Narrow sources are left alone — dropping a column from a 4-column
 * artifact saves nothing and hides data.
 */
function bulkyColumns(rows: string[][], columns: WsColumn[], keep?: Set<number>): Set<number> {
  const drop = new Set<number>()
  if (columns.length <= WIDE_ROW_COLS || rows.length === 0) return drop
  for (let i = 0; i < columns.length; i++) {
    if (keep?.has(i)) continue
    let longest = 0
    for (const r of rows) longest = Math.max(longest, (r[i] ?? '').length)
    if (longest > BULKY_CELL_CHARS) drop.add(i)
  }
  // Never drop everything: if a source is ALL huge columns, the sample has to show something.
  return drop.size >= columns.length ? new Set<number>() : drop
}

/** Names of the dropped columns, for the note that tells the caller how to get them back. */
function droppedNames(columns: WsColumn[], drop: Set<number>): string[] {
  return [...drop].map((i) => columns[i]?.original ?? `c${i}`)
}

/** Resolve a model-supplied `columns` list (ids or labels) to a set of column INDICES for projection.
 *  Unknown columns are ignored; an empty/absent list returns undefined (no projection — all columns). */
function pickColumns(columns: WsColumn[], requested: unknown): Set<number> | undefined {
  if (!Array.isArray(requested) || requested.length === 0) return undefined
  const idx = new Set<number>()
  for (const r of requested) {
    try {
      const name = resolveCol(r, columns)
      const i = columns.findIndex((c) => c.name === name)
      if (i >= 0) idx.add(i)
    } catch {
      /* ignore an unknown column rather than failing the whole call */
    }
  }
  return idx.size > 0 ? idx : undefined
}

/** Clip a model-supplied free-text field, but NEVER silently. These fields carry the reasoning a
 *  grader most needs (especially a lead's why_uncertain), so a truncated value is marked with an
 *  ellipsis AND reported back — losing the tail of an explanation without saying so is worse than
 *  losing it from a description. Caps are generous; they exist to bound payload, not to edit prose. */
// Stray tool-call markup leaking into a value the ANALYST will read. A malformed technique argument
// once landed `</description><parameter name="technique">T1070.001` inside a stored event description,
// which then rendered as garbage in the Timeline and silently dropped the ATT&CK attribution. These
// fields are human-facing prose — a closing tag or a parameter preamble in one is never intended.
const STRAY_MARKUP = /<\/?(?:description|parameter|invoke|function_calls|antml:[a-z_]+)\b[^>]*>/gi

function clipField(v: unknown, cap: number, name: string, warnings: string[]): string | null {
  let t = typeof v === 'string' ? v.trim() : ''
  if (STRAY_MARKUP.test(t)) {
    STRAY_MARKUP.lastIndex = 0 // global regex — reset before the replace, and after the test above
    t = t.replace(STRAY_MARKUP, ' ').replace(/\s+/g, ' ').trim()
    warnings.push(
      `${name} contained tool-call markup, which was stripped before storing — check the ${name} that was saved, and re-send it if the value is now wrong. This usually means an argument was malformed.`
    )
  }
  STRAY_MARKUP.lastIndex = 0
  if (!t) return null
  if (t.length <= cap) return t
  warnings.push(`${name} was ${t.length} characters and has been clipped to ${cap} — re-send a shorter ${name} if the tail mattered.`)
  return t.slice(0, cap - 1) + '…'
}

/** Normalize model-supplied filters and FAIL LOUDLY if any clause was dropped. A silently discarded
 *  clause turns a filtered query into an UNFILTERED one and returns plausible-looking wrong numbers —
 *  the worst failure mode there is, because nothing about the result looks wrong. Wrong input must
 *  error, not quietly widen the query. */
function strictFilters(raw: unknown, columns: WsColumn[]): ReturnType<typeof normalizeFilters> {
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const timeProblem = timeFilterProblem(raw, columns)
  if (timeProblem) throw new Error(timeProblem)
  const out = normalizeFilters(resolveFilterCols(raw, columns) as never)
  const kept = out?.length ?? 0
  if (kept < raw.length) {
    throw new Error(
      `${raw.length - kept} of ${raw.length} filter clause(s) are invalid and would have been IGNORED — the query would have run unfiltered and returned wrong numbers. Valid shapes: {col, op:"eq"|"neq"|"like"|"nlike", value}; {col, op:"in", values:[…]}; {col, op:"timerange", tkind:"iso"|"epoch_s"|"epoch_ms", from?, to?} where from/to accept epoch seconds OR an ISO timestamp; {col, op:"timearound", tkind, value, deltaSec}.`
    )
  }
  return out
}

/** Render a normalized filter set (+ optional search) as a SHORT human-readable criteria string, using
 *  the source's display headers rather than c-ids. This becomes an evidence item's `matched` value, so
 *  the analyst can see WHAT selected the rows (not the old opaque literal "filter") and the agent can
 *  audit its own basis on resume. It also makes the merge key unique per criteria — two different
 *  filter-based evidence items in one source used to collide on "filter" and clobber each other. */
function describeCriteria(filters: unknown, search: string | undefined, columns: WsColumn[]): string {
  const label = (c: unknown): string => {
    const name = String(c ?? '')
    return columns.find((x) => x.name === name)?.original ?? name
  }
  const q = (v: unknown): string => `"${String(v ?? '')}"`
  const parts: string[] = []
  if (search) parts.push(`contains ${q(search)}`)
  for (const raw of Array.isArray(filters) ? filters : []) {
    const f = raw as Record<string, unknown>
    const op = String(f.op ?? '')
    if (op === 'eq') parts.push(`${label(f.col)} = ${q(f.value)}`)
    else if (op === 'neq') parts.push(`${label(f.col)} != ${q(f.value)}`)
    else if (op === 'like') parts.push(`${label(f.col)} contains ${q(f.value)}`)
    else if (op === 'nlike') parts.push(`${label(f.col)} not contains ${q(f.value)}`)
    else if (op === 'in') {
      const vals = Array.isArray(f.values) ? (f.values as unknown[]) : []
      const shown = vals.slice(0, 3).map((v) => String(v)).join(', ')
      parts.push(`${label(f.col)} in [${shown}${vals.length > 3 ? `, +${vals.length - 3} more` : ''}]`)
    } else if (op === 'timerange') parts.push(`${label(f.col)} in time range`)
    else if (op === 'timearound') parts.push(`${label(f.col)} within ${String(f.deltaSec ?? '?')}s of ${String(f.value ?? '')}`)
    else if (op === 'tag') parts.push(`tagged ${(Array.isArray(f.tags) ? f.tags : []).join('/')}`)
    else if (op === 'sighting') parts.push('has intel sighting')
    else if (op === 'aimark') parts.push('AI-marked')
    else if (op === 'rids') parts.push('selected rows')
  }
  return parts.join(' AND ').slice(0, 240)
}

/** Build a sort from a model-supplied order_by column + direction. Numeric sort is inferred for
 *  epoch time columns so "earliest event" orders chronologically rather than lexically. */
function sortFromArgs(src: WsSource, orderBy: unknown, order: unknown): Sort | undefined {
  if (orderBy == null || String(orderBy).trim() === '') return undefined
  let col: string
  try {
    col = resolveCol(orderBy, src.columns)
  } catch {
    return undefined // unknown column → unsorted rather than erroring
  }
  const meta = src.columns.find((c) => c.name === col)
  // Numeric sort comes from the flag decided at INGEST, so the agent and the grid order a column
  // the same way. Epoch time columns stay numeric on their own kind, as before.
  const numeric = meta?.numeric === true || meta?.time === 'epoch_s' || meta?.time === 'epoch_ms'
  const dir: 'asc' | 'desc' = String(order).toLowerCase() === 'desc' ? 'desc' : 'asc'
  return { col, dir, numeric }
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

/**
 * Why a time-filtered search came back empty — the column it filtered on, that column's REAL span,
 * and whether the value occurs at all once the window is dropped.
 *
 * Best-effort: this runs only on the 0-row path and must never turn a legitimate empty result into an
 * error, so any failure here is swallowed and the caller just reports the plain zero.
 */
async function explainEmptyWindow(
  src: WsSource,
  value: string,
  args: Record<string, unknown>
): Promise<{ timeColumn: string; columnSpans: string; matchesIgnoringWindow: number; hint: string } | undefined> {
  try {
    const tc = resolveTimeColumn(src, args.time_column)
    const range = await dbw.call<{ tsMin: number | null; tsMax: number | null }>('getTimeColumnRange', src.tabId, tc.id, tc.kind)
    const untimed = (await dbw.count(src.tabId, reqSeq++, undefined, value, () => {})) ?? 0
    const asIso = (t: number | null): string => (t == null ? 'unknown' : new Date(t * 1000).toISOString())
    const spans = range.tsMin == null ? 'no parseable values' : `${asIso(range.tsMin)} … ${asIso(range.tsMax)}`
    const others = timeColumnsOf(src).filter((c) => c.id !== tc.id)
    return {
      timeColumn: tc.label,
      columnSpans: spans,
      matchesIgnoringWindow: untimed,
      hint:
        untimed > 0
          ? `"${value}" occurs ${untimed} time(s) in this source, but none inside your window on "${tc.label}" (which spans ${spans}). Check that "${tc.label}" is the timestamp you mean — many artifacts carry a file/binary time rather than an execution time — or widen the window.` +
            // Only offer alternatives that ARE alternatives: naming the column just used as an
            // "other" option is the kind of suggestion a reader learns to stop reading.
            (others.length ? ` Other time columns in this source: ${others.map((c) => `${c.label}=${c.id}`).join(', ')}.` : '')
          : `"${value}" does not occur in this source at all, with or without the time window — the window is not what excluded it.`
    }
  } catch {
    return undefined
  }
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
      'List every source (imported artifact/CSV) in the open workspace — e.g. the many files of a KAPE triage package plus a Hayabusa timeline. Returns each source\'s name, a path-style `path` ("Group/name") and numeric `id` for unambiguous targeting (use these, not the bare name, when hosts share a filename), row count, column count, and its `group` (the analyst-assigned host/system/origin the artifact came from, e.g. "HOST-A", "PaloAlto-Perimeter", or null when ungrouped), plus a `groups` summary listing the sources in each group. Use the groups to scope an investigation to one host/system and to corroborate ACROSS the artifacts of the same machine. CALL THIS FIRST to learn what artifacts you have, then investigate ACROSS them: corroborate a finding in one source (e.g. a binary in a Hayabusa detection) against others (Amcache, Prefetch, MFT, registry, …). Pass a source name to the other tools via their `source` argument.',
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
        columns: { type: 'array', items: { type: 'string' }, description: 'Only return these columns (ids/labels) in the sample — cuts noise and token cost. Omit for all columns.' },
        ...SOURCE_PARAM
      },
      required: ['value'],
      additionalProperties: false
    }
  },
  {
    name: 'find_in_all_sources',
    description:
      'Search a value across loaded sources at once and return, per source, the match count and a small sample — the fast way to answer "where does this appear?" without calling find_rows on each artifact. Use it to find which artifacts corroborate an indicator (a binary, hash, account, path), then call find_rows on a specific source for the exact whole-token rows. Counts here are CONTAINS (substring) counts; for an IP/hash the precise whole-token count comes from find_rows on that source. SCOPE: by default this fans out across EVERY loaded source — when you are investigating a single host/system (or the analyst scoped you to one), pass `groups` (e.g. ["HOST-A"]) so it only searches that host\'s sources and never pulls in another system\'s artifacts.',
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
    parameters: {
      type: 'object',
      properties: {
        columns: { type: 'array', items: { type: 'string' }, description: 'Only return these columns (ids/labels) — cuts noise and token cost. Omit for all columns.' },
        ...SOURCE_PARAM
      },
      additionalProperties: false
    }
  },
  {
    name: 'find_around_time',
    description:
      'Cross-source TEMPORAL pivot — find rows within ±N seconds of a timestamp across loaded sources, the fast way to align an event\'s traces in time ("what else happened within 60s of this Hayabusa detection?"). For each source with a single time column it applies the window automatically; sources with NO time column, or with several (ambiguous), are returned under `skipped` so you can target them with find_rows + an explicit time_column. Optionally narrow to rows that also contain a value. Returns per-source counts + a tiny sample. SCOPE: by default it fans out across EVERY loaded source — when investigating a single host/system, pass `groups` (e.g. ["HOST-A"]) so it only correlates within that host\'s sources.',
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
      'Count rows in a source matching structured filters (and/or a contains search) and return a small sample. Use this for structured questions ("how many rows where status=denied", time ranges, multiple conditions). NEVER assume row values — call this to see real data. Use column `id`s (c0, c1, …) from describe_workspace. To simply check whether a value/indicator appears anywhere, prefer find_rows; to get a DISTRIBUTION (counts per value, per hour, …) use aggregate instead of many queries. Sort with order_by/order (e.g. earliest events: order by the time column ASC) and trim the payload with `columns`. Returns the total match count plus up to 25 sample rows. PAGE THROUGH a large match with `offset`: the result reports `nextOffset` whenever more rows remain, so you can walk a 275-row burst instead of narrowing filters until it fits.',
    parameters: {
      type: 'object',
      properties: {
        filters: {
          type: 'array',
          description:
            'Filter clauses, ANDed together. Each is one of: {col, op:"like"|"nlike", value} (like = CONTAINS, the usual choice for matching text); {col, op:"eq"|"neq", value} (EXACT — matches only when the whole cell equals value, e.g. a status code; do NOT use eq to look for a value inside log text); {col, op:"in", values:[...]}; {col, op:"timerange", tkind:"iso"|"epoch_s"|"epoch_ms", from?, to?} where `tkind` describes how the COLUMN stores its timestamps, and from/to accept either epoch SECONDS or an ISO-8601 string (an unparseable bound is rejected, never silently ignored).',
          items: { type: 'object' }
        },
        search: { type: 'string', description: 'Free-text term matched across all columns (contains).' },
        order_by: { type: 'string', description: 'Column id/label to sort the sample by (e.g. a time column for chronological order). Epoch time columns sort numerically.' },
        order: { type: 'string', enum: ['asc', 'desc'], description: 'Sort direction for order_by (default asc). Use asc on a time column for the EARLIEST rows.' },
        columns: { type: 'array', items: { type: 'string' }, description: 'Only return these columns (ids/labels) in the sample — cuts noise and token cost when rows carry huge blob fields (e.g. _raw, AuditData). Omit for all columns.' },
        limit: { type: 'number', description: 'Sample rows to return (max 25).' },
        offset: {
          type: 'number',
          description:
            'Skip this many matching rows before sampling — how you page past the first 25. Pass the `nextOffset` from the previous result to walk a large match in order.'
        },
        ...SOURCE_PARAM
      },
      additionalProperties: false
    }
  },
  {
    name: 'aggregate',
    description:
      'Group rows by a column and COUNT them — a whole DISTRIBUTION / histogram in ONE call instead of firing many query_workspace calls. Use for "events by user", "logins by hour", "detections by rule/severity", "top talkers". Optionally: restrict with the same `filters`/`search` as query_workspace (e.g. count distinct UserIds WHERE Operation=UserLoggedIn); for a TIME column set `bucket` (hour/day/month/hourofday/dayofweek) to get a time histogram; set `by` to a second column for a 2-D pivot (col × by, e.g. hour × user). Returns {value, count} rows (or {value, by, count} for a pivot), ordered by count desc (default) or by value ascending (order:"value", for a chronological time histogram). Prefer this over brute-forcing per-value or per-hour counts.',
    parameters: {
      type: 'object',
      properties: {
        col: { type: 'string', description: 'Column to group by (id like c3, or its label).' },
        by: { type: 'string', description: 'Optional second column to cross-tabulate against — makes a 2-D pivot (col × by).' },
        bucket: { type: 'string', enum: ['minute', 'hour', 'day', 'month', 'year', 'hourofday', 'dayofweek'], description: 'For a TIME column only: bucket timestamps to this resolution. hour/day/month truncate; hourofday (00-23) and dayofweek (0=Sunday) are cyclic distributions.' },
        filters: { type: 'array', items: { type: 'object' }, description: 'Optional row filters (same grammar as query_workspace) to restrict what is counted.' },
        search: { type: 'string', description: 'Optional free-text term to restrict rows before grouping.' },
        order: { type: 'string', enum: ['count', 'value'], description: 'Order buckets by count desc (default) or by value ascending (use "value" for a chronological time histogram).' },
        limit: { type: 'number', description: 'Max buckets to return (default 50, max 500).' },
        ...SOURCE_PARAM
      },
      required: ['col'],
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
      'Assign a source (imported artifact) to a GROUP — the host/system/origin it came from (e.g. "HOST-A", "DC1", "PaloAlto-Perimeter"). This is the analyst-facing grouping shown in the sidebar and used as the Timeline\'s Host. Use it to attribute artifacts to the right machine once you work out which file came from where (e.g. all of a KAPE package\'s CSVs belong to one host). This CHANGES the workspace and REQUIRES the analyst to confirm before it applies. Pass an empty group to remove a source from its group. Set one source per call.',
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
        uncertainty: { type: 'string', description: 'What about this event is UNSETTLED, in a sentence. Evidence proves the event OCCURRED; it does not settle what the occurrence MEANS. Use this when the execution is certain but the reading is genuinely contested — e.g. a memory-dumping tool that ran inside an attacker window but sat on disk a week early beside 7-Zip and Notepad++, which is equally the IR team own kit. Do NOT demote such a thing to record_lead: the execution is not in doubt, only its attribution. Naming the doubt sorts it to the top of the review queue instead of letting it render as settled fact. Leave it out when nothing is contested; do not manufacture doubt.' },
        technique: { type: 'string', description: 'Optional MITRE ATT&CK technique id or name (e.g. "T1685" or "Disable or Modify Tools"). A retired id is upgraded to its current one automatically.' },
        users: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional: the user account(s) this event INVOLVES, when the rows make it evident (e.g. ["HOST-A\\\\jsmith"] for a logon or a process run as that account). Populates the Timeline\'s User column. Omit when no account is involved or attribution is ambiguous — do not guess.'
        },
        corroboration_checked: {
          type: 'boolean',
          description:
            'Set true when you have already considered cross-artifact corroboration for this event (e.g. it is only ever observable in one artifact) — suppresses the corroboration nudge.'
        },
        replace_evidence: {
          type: 'boolean',
          description:
            'Replace this event’s evidence entirely with the items in THIS call, instead of merging. Use it to re-record with tighter scoping and drop an earlier over-broad item (merging would leave both attached).'
        },
        evidence: {
          type: 'array',
          description:
            'The rows that corroborate the event — one item per piece of evidence. Each item: {source, and ONE of value | search | filters, why?}. At least one must validate (match ≥1 row) or the event is not recorded. Evidence MERGES across calls by (source, criteria) unless replace_evidence is true. Set breadth_intended: true on an item whose WIDTH is the finding (e.g. "275 channels cleared") so it is not flagged as sloppy scoping.',
          items: {
            type: 'object',
            properties: {
              source: { type: 'string', description: 'Source/artifact name (from list_sources) the evidence is in.' },
              value: { type: 'string', description: 'A value to match in that source (whole-token for IPs/hashes).' },
              search: { type: 'string', description: 'A contains term across all columns (alternative to value).' },
              filters: {
                type: 'array',
                items: { type: 'object' },
                description:
                  'Structured filters instead of value/search, using EXACTLY the grammar query_workspace takes — e.g. [{"col":"c5","op":"eq","value":"4624"},{"col":"c9","op":"like","value":"10.0.0.5"}], ANDed together. Use this when the evidence is "these rows matching these conditions" rather than one literal string.'
              },
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
      'Catalog an indicator of compromise (IOC) you encounter during the investigation, with its TYPE from the fixed taxonomy. This builds the case IOC list. It does NOT send anything to the Intel/enrichment grid — sending an (enrichable) IOC there is a deliberate human decision. Types — Primary: ip, domain, url, email, hash, account; Secondary: filename, filepath, process, commandline, useragent, cloud; Tertiary: registry, service, scheduledtask, mutex, namedpipe, tlsfingerprint, certificate, pdbpath. Pick the most specific type. Use `account` for a compromised or attacker-used identity ("EXAMPLE\svc_account", a service account, a UPN) — an intrusion is usually driven by ONE account and it is the thread tying otherwise-unrelated hosts together, so it belongs in the catalog rather than being filed under `process`.',
    parameters: {
      type: 'object',
      properties: {
        value: { type: 'string', description: 'The indicator value.' },
        type: {
          type: 'string',
          enum: ['ip', 'domain', 'url', 'email', 'hash', 'account', 'filename', 'filepath', 'process', 'commandline', 'useragent', 'cloud', 'registry', 'service', 'scheduledtask', 'mutex', 'namedpipe', 'tlsfingerprint', 'certificate', 'pdbpath'],
          description: 'The IOC type from the taxonomy.'
        },
        context: { type: 'string', description: 'Optional: where/why you saw it (e.g. "C2 from PowerShell beacon in Hayabusa").' }
      },
      required: ['value', 'type'],
      additionalProperties: false
    }
  },
  {
    name: 'record_lead',
    description:
      'Record a LEAD — an UNPROVEN inference, hypothesis, or suggestion you cannot (yet) confirm as an event: "this pattern SUGGESTS ClickFix delivery", "you should check X", "there may be hidden persistence here". Leads are kept SEPARATE from events so your uncertainty never reads as fact — they surface in the Investigation panel, flagged as hypotheses, for the analyst to pursue, promote to an event once evidence confirms it, or dismiss. A lead MUST cite grounding: the actual rows that prompted the inference (same {source, value|search|filters} form as evidence, validated against the data — no ungrounded hunches). Use this instead of burying a suspicion in an event\'s description or only in prose. When you later CONFIRM a lead with real corroboration, record it as an event with record_event.',
    parameters: {
      type: 'object',
      properties: {
        statement: { type: 'string', description: 'The hypothesis/inference/suggestion (e.g. "Suspected ClickFix: explorer.exe spawned a hidden PowerShell").' },
        why_uncertain: { type: 'string', description: 'Optional: what is missing or ambiguous — why this is a lead, not a confirmed event (e.g. "no delivery artifact found yet").' },
        next_step: { type: 'string', description: 'Optional: a concrete next step to confirm or refute it (e.g. "check browser history for a clipboard paste around 09:14").' },
        grounding: {
          type: 'array',
          description:
            'The rows that prompted this inference — one item per piece, SAME form as record_event evidence: {source, and ONE of value | search | filters, column?, time_from?, time_to?, time_column?}. At least one must match ≥1 real row or the lead is not recorded (no ungrounded leads).',
          items: { type: 'object' }
        }
      },
      required: ['statement', 'grounding'],
      additionalProperties: false
    }
  },
  {
    name: 'update_event',
    description:
      'Correct an event you already recorded — its label, description, ATT&CK technique, or the users it involves. Use this when the wording turns out to be wrong (e.g. you titled it "Defender & Firewall logs cleared" and the truth is 275 channels). Do NOT re-record with a corrected label: an event’s identity is derived from its label, so record_event with new wording creates a SECOND event and orphans the first. Evidence is untouched. Get the event_id from list_events. An event the analyst has taken over is not editable by you.',
    parameters: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'The event’s id, from list_events.' },
        uncertainty: { type: 'string', description: 'Correct what is UNSETTLED about this event. Pass an empty string to settle it once the question is resolved. Omit to leave it as recorded.' },
        label: { type: 'string', description: 'Corrected title of the action/event.' },
        description: { type: 'string', description: 'Corrected description.' },
        technique: { type: 'string', description: 'Corrected MITRE ATT&CK technique id or name.' },
        users: { type: 'array', items: { type: 'string' }, description: 'Corrected user account(s) the event involves.' }
      },
      required: ['event_id'],
      additionalProperties: false
    }
  },
  {
    name: 'list_events',
    description:
      'Read back the events (Artifact Constellation nodes) you have recorded so far — each with its label, ATT&CK technique, the user account(s) it involves (`users`), the sources that corroborate it, its per-item `evidence` (each source + the exact value/search you `matched` there + the `rows` it hit), and its TIMING: an overall `timeSpan` (UTC start/end across the evidence) plus `times`, the per-timestamp-KIND spans (e.g. Created vs Modified kept distinct, ISO-8601 UTC). Use it to (a) AUDIT your own work — spot events citing only 1–2 sources, re-read exactly what each cited via `evidence[].matched`, or find events that involve an account but have empty `users` to attribute; (b) CORROBORATE — take a key artifact from `evidence[].matched` (a binary, hash, path) and search for it in the OTHER sources with find_rows/find_in_all_sources, then re-record the event with the same label to merge in the new evidence; and (c) build a CHRONOLOGY from recorded data instead of memory (order by timeSpan; pick the relevant kind from `times`). Undated events have timeSpan: null. Each event also reports the HOST(S) it happened on (`hosts`, derived from the group of every source it cites) plus a `byHost` roll-up, and you can scope the call with `hosts` — so "what happened on this machine" no longer means re-reading everything. An event with two hosts is not a mistake: a lateral movement legitimately has evidence at both ends.',
    parameters: {
      type: 'object',
      properties: { hosts: { type: 'array', items: { type: 'string' }, description: 'Optional: only events citing evidence from these host groups (from list_sources).' } },
      additionalProperties: false
    }
  },
  {
    name: 'list_iocs',
    description:
      'Read back the IOC catalog you have built so far — each indicator with its taxonomy type and context. Use it to review what you have collected and avoid duplicates.',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'update_lead',
    description:
      'Correct or CLOSE one of your leads. A lead that is answered must not sit open: a stale lead misrepresents your confidence in BOTH directions — one whose text still says "I have not searched everywhere" overstates your doubt once you have, and one offering a branch you have since disproved is actively misleading. Set status to "refuted" (you checked and ruled it out — a durable negative result worth recording, not a deletion), "superseded" (a better-supported lead or event replaces it; pass superseded_by), or "open" to reopen. Always give a `resolution` saying what settled it. You can also edit the statement/why_uncertain/next_step in place — re-recording with record_lead would fork a second lead instead of correcting this one. Get the lead_id from list_leads.',
    parameters: {
      type: 'object',
      properties: {
        lead_id: { type: 'string', description: 'The lead’s id, from list_leads.' },
        status: { type: 'string', enum: ['open', 'refuted', 'superseded'], description: 'refuted = checked and ruled out; superseded = replaced by something better supported; open = reopen.' },
        resolution: { type: 'string', description: 'What settled it (e.g. "searched all 31 sources; no LaZagne artifact in any"). This is the durable negative result.' },
        superseded_by: { type: 'string', description: 'For status "superseded": the lead/event that replaces this one.' },
        statement: { type: 'string', description: 'Optional corrected statement.' },
        why_uncertain: { type: 'string', description: 'Optional corrected uncertainty note.' },
        next_step: { type: 'string', description: 'Optional corrected next step.' }
      },
      required: ['lead_id'],
      additionalProperties: false
    }
  },
  {
    name: 'list_leads',
    description:
      'Read back the LEADS (unproven hypotheses) you have recorded — each with its `id`, `status` (open/refuted/superseded/promoted), any `resolution`, its statement, why it is uncertain, the suggested next step, and its grounding (source + what you matched + row count). Use it to review OPEN hypotheses, avoid duplicates, and close the ones you have since answered with update_lead — a lead left open after you have resolved it misrepresents your confidence.',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'list_case_report',
    description:
      'Read the CASE REPORT: every claim this case contains — recorded events, unproven leads, proven absences, evidence gaps and entity verdicts — in one list, each with the analyst\'s verdict on it (pending, approved, or REJECTED with their reason). Call this when resuming, and before you conclude. Two things it tells you that nothing else does: which of your claims the analyst has ALREADY REJECTED and WHY — do not re-assert a rejected claim, and take the stated reason as a correction to work from — and which claims are still pending review, so you can see what you have left them to adjudicate. You cannot set verdicts: agreeing or disagreeing with a finding is the analyst\'s call, the same rule as the Benign tag and a CLEARED entity. Flags worth reading: `single-source` (an event only one artifact backs), `stale` and `overturned` (an absence that new evidence has outrun or broken), `asserted` (an entity nothing in the data names yet).',
    parameters: {
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: ['pending', 'approved', 'rejected'], description: 'Optional: only claims with this verdict. Use "rejected" to review the corrections you have been given.' },
        hosts: { type: 'array', items: { type: 'string' }, description: 'Optional: only claims concerning these host groups.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'record_negative',
    description:
      'Record a PROVEN ABSENCE — something you checked for and did NOT find, or a gap in the evidence itself. This is the counterpart to record_event: that tool refuses evidence matching zero rows, which means a proven absence was previously impossible to record and survived only in your prose. Use it for conclusions like "no ransomware extensions appear anywhere under the shares after the script ran", "this host\'s Security log contains zero Type-10 logons", "the AppCompatCache does not cover the intrusion window". These are often the MOST consequential things an investigation establishes — "not encrypted" is the difference between a data-theft incident and a ransomware detonation — and an analyst cannot act on one that exists only in a paragraph. The absence is VALIDATED: the tool runs your search and REFUSES the record if it matches anything, telling you what it found, because a "negative" that matches rows is not a negative — it is a discovery you had not noticed. The scope is stored with the claim (which sources, what pattern, what window), so it can be re-run later with verify_negative and is flagged STALE when evidence arrives that it never covered. Use kind "gap" for a claim about the EVIDENCE rather than the intrusion (a parser that failed, an artifact class nobody could parse); a gap needs no search.',
    parameters: {
      type: 'object',
      properties: {
        statement: { type: 'string', description: 'The absence, stated plainly (e.g. "No ransomware file extensions were created under the shares after the push"). Max 500 characters — an over-long statement is REFUSED, not truncated, so put supporting detail in why_it_matters (2000) rather than the claim itself. State only what you actually searched for: if the sentence names three things, search all three (see `values`).' },
        kind: { type: 'string', enum: ['absence', 'gap'], description: 'absence = you searched and found nothing (default). gap = the evidence itself is missing or unparsed; no search is run.' },
        why_it_matters: { type: 'string', description: 'Why an analyst should care that this is absent — what it rules out, or what it changes.' },
        sources: { type: 'array', items: { type: 'string' }, description: 'Sources to search. Omit to search every source (or every source of `hosts`). The set searched is stored as the claim\'s scope.' },
        hosts: { type: 'array', items: { type: 'string' }, description: 'Restrict the search to these host groups. Recorded with the claim, so re-verification uses the same scope.' },
        value: { type: 'string', description: 'A single value you looked for and did not find (same matching as find_rows). For several, use `values`.' },
        values: { type: 'array', items: { type: 'string' }, description: 'SEVERAL values, each searched and each required to match nothing. Use this whenever your statement names more than one thing — claiming "no .locked, .encrypted or .lockbit" while searching only ".locked" records a claim broader than what was verified. If one term hits, the refusal names WHICH, so you can record the narrower absence that does hold. All terms are stored, so verify_negative re-checks every one.' },
        search: { type: 'string', description: 'Free-text term to look for instead of `value`.' },
        filters: { type: 'array', items: { type: 'object' }, description: 'Structured conditions instead of value/search (same grammar as query_workspace).' },
        time_from: { type: 'string', description: 'Optional window start (ISO-8601 or epoch seconds) — an absence is usually only meaningful over a window.' },
        time_to: { type: 'string', description: 'Optional window end.' },
        time_column: { type: 'string', description: 'Which time column bounds the window (defaults to the source\'s event-time column).' }
      },
      required: ['statement'],
      additionalProperties: false
    }
  },
  {
    name: 'verify_negative',
    description:
      'Re-run a recorded absence against the case AS IT STANDS NOW and report whether it still holds. Absence is only ever true relative to what you searched, so a negative established before more evidence was imported is unverified rather than wrong — list_negatives marks those STALE. This re-runs the stored query over the current sources: either it reconfirms the claim (and the staleness clears) or it OVERTURNS it, in which case the rows that broke it are the finding. Call it after importing evidence that could bear on an absence you already recorded.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The negative\'s id, from list_negatives.' } },
      required: ['id'],
      additionalProperties: false
    }
  },
  {
    name: 'list_negatives',
    description:
      'List the proven absences and evidence gaps recorded in this case — each with its statement, the scope that was searched, when it was established, and whether it is STALE (evidence has been imported since that the original search never covered) or OVERTURNED (a re-run found rows, so it no longer holds). Read this before concluding: an absence you established early may have been invalidated by evidence imported later, and reporting a stale negative as fact is how a "this host was clean" conclusion goes wrong.',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'record_entity',
    description:
      'Record a SYSTEM or ACCOUNT as a subject of this case, with your verdict on it. Entities are not IOCs: an IOC is a value you would hunt for or share, an entity is a thing in THIS investigation that carries state (is it compromised? do we even have its data?). Use this for the hosts and accounts the intrusion touched. The MOST IMPORTANT case is a system you can see in the data but whose triage package was never collected — a host named as the target of a remote execution, a share, or a logon. Recording it turns "I noticed six hosts I have no artifacts for" into a collection request the analyst can act on, instead of a line of prose. Whether we hold an entity\'s data is worked out from the sources; you do not assert it. If the case already names the entity, or you cite grounding, it is stored as EVIDENCED; otherwise it is stored as ASSERTED and shown as such — so you may safely record a host you only suspect exists, and it is promoted automatically once the data catches up. You may set status compromised, suspected, or unknown; only the analyst may declare something CLEARED.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['system', 'account'], description: 'system = a host/machine. account = a user or service principal.' },
        name: { type: 'string', description: 'The host or account name as it appears in the data (e.g. "HOST-A", "EXAMPLE\\\\svc_account"). Case is preserved for display; matching ignores it. A domain-qualified account is NOT merged with the bare name — record it as you see it.' },
        status: { type: 'string', enum: ['compromised', 'suspected', 'unknown'], description: 'Your verdict. Omit if you have not judged it yet.' },
        role: { type: 'string', description: 'Optional: what it is in the environment (e.g. "domain controller", "service account for backups").' },
        notes: { type: 'string', description: 'Optional: what you know about its involvement — especially, if its data was never collected, WHY it matters and what you would want from it.' },
        grounding: {
          type: 'array',
          description:
            'Optional but strongly preferred: the rows that show this entity in the data — same {source, value|search|filters} form as record_event evidence. Grounding is what makes an entity EVIDENCED rather than asserted, and it accretes across calls.',
          items: { type: 'object' }
        }
      },
      required: ['kind', 'name'],
      additionalProperties: false
    }
  },
  {
    name: 'link_entities',
    description:
      'Answer a "are these the same?" question about two systems or accounts — the app SUGGESTS links (record_entity returns `possibleAliases`) but never merges on its own, because getting it wrong corrupts attribution invisibly. Use same=true to merge: the second name becomes an alias of the first, its grounding is folded in, and it stops appearing as a separate entity. Use same=false to record that they are genuinely DIFFERENT, which stops the app proposing that pair again. Both answers are worth recording. The distinction is real and needs evidence, not a guess: a domain-qualified account and its FQDN/NetBIOS variant are usually ONE principal, whereas a LOCAL account and a DOMAIN account sharing a name are DIFFERENT principals — check the SIDs or the profile directories before merging. Merging a host with an IP address is also how you tell the app that an address you recorded is a machine already in the case, which stops it being reported as an uncollected host.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['system', 'account'], description: 'Both names must be the same kind.' },
        entity: { type: 'string', description: 'The name to keep — the primary/canonical form.' },
        other: { type: 'string', description: 'The other name. On a merge this becomes an alias of `entity`.' },
        same: { type: 'boolean', description: 'true = they are one entity (merge). false = they are different (stop suggesting it).' },
        reason: { type: 'string', description: 'Why — the evidence for your answer (e.g. "same SID", "distinct SIDs and separate profile directories").' }
      },
      required: ['kind', 'entity', 'other', 'same'],
      additionalProperties: false
    }
  },
  {
    name: 'list_entities',
    description:
      'List the SYSTEMS and ACCOUNTS in this case — both the ones the data already names (every host that produced a source, every account your recorded events involve) and the ones curated with record_entity. Each carries `origin` (evidenced/asserted), `status`, `collected` (do we hold its data?), and how many events involve it. CALL THIS EARLY: it tells you which hosts you actually have artifacts for before you plan around them, and it is where you check whether a host you just saw referenced is one you can pivot into or one nobody collected. Entities where evidenced is true and collected is false are the case\'s collection gaps.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['system', 'account'], description: 'Optional: restrict to one kind. Omit for both.' },
        uncollected_only: { type: 'boolean', description: 'Only entities the case evidences but whose data was never collected — the collection gaps.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'get_investigation_state',
    description:
      'Recover the investigation state that persists across sessions: the saved plan (steps with pending/active/done), the latest progress note, and a roll-up of how much has been recorded (events, IOCs). CALL THIS FIRST when resuming an investigation so you continue from where you left off instead of re-deriving — then follow up with list_events / list_iocs for the detail. Returns empty plan/notes when nothing has been recorded yet.',
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
      'List the distinct values of one column in a source and how often each occurs (e.g. "what event levels / hosts / signatures are present?"). Use a column `id` (c0, c1, …). Pass `filters` to restrict which rows are counted (e.g. distinct UserIds WHERE Operation=UserLoggedIn). For a distribution across a SECOND dimension, or a time histogram, use aggregate. To DRILL INTO a bucket, reuse the `appliedFilters` this returns and add an `eq` clause on the same column — do not retype the filters, because dropping one (a time window especially) changes the answer by orders of magnitude. Displayed values are truncated; when two look identical the tool says so in `clippedValues`, and the underlying values really are distinct.',
    parameters: {
      type: 'object',
      properties: {
        col: { type: 'string', description: 'Column id (c0, c1, …) or display label.' },
        filters: { type: 'array', items: { type: 'object' }, description: 'Optional row filters (same grammar as query_workspace) — count distinct values only among matching rows.' },
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
    name: 'list_workspaces',
    description:
      'List the cases (workspaces) that already exist on this machine — each with its `name`, how many sources it holds, and when it was created. Use this before create_case to check whether the case you are about to build ALREADY EXISTS, and to find a case to resume with use_workspace. Creating a duplicate case for work already done is a real cost to the analyst: it splits one investigation across two files.',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'create_case',
    description:
      'Create a NEW empty case (workspace) and open it in the app, so the analyst watches it fill as you work. Everything you record afterwards — sources, events, IOCs, leads, the plan — lands in this case. Call list_workspaces FIRST to be sure the case does not already exist; use use_workspace to resume one instead of duplicating it — an exact-name duplicate is REFUSED, because it would split one investigation across two files. After creating, call list_evidence to see what you can import, then import_evidence. Name the case for the investigation, not the date (e.g. "Ransomware triage — HOST-A" beats "Case 1").',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'A descriptive case name the analyst will recognize in the tab bar.' } },
      required: ['name'],
      additionalProperties: false
    }
  },
  {
    name: 'use_workspace',
    description:
      'Open an EXISTING case (workspace) and make it the one you are driving — how you resume an investigation from a previous session. Accepts the case name from list_workspaces (or its id). Once it is open, call get_investigation_state to recover the plan, progress note and everything already recorded before you do any new work, so you continue rather than restart.',
    parameters: {
      type: 'object',
      properties: { workspace: { type: 'string', description: 'The case name (or id) from list_workspaces.' } },
      required: ['workspace'],
      additionalProperties: false
    }
  },
  {
    name: 'list_evidence',
    description:
      'List the evidence files the analyst has made available to you, as paths RELATIVE to the evidence folder they configured (e.g. "HOST-A/Amcache.csv"). That folder is the ONLY place you can read from — you cannot name or open a file anywhere else on the machine, and you cannot change which folder it is. Each entry reports its `group` (the top-level subdirectory, which is how a triage package encodes the HOST the artifact came from), size, and `importable` (whether the app can ingest it — CSV/TSV/Excel). Non-importable files are listed too, so you can see what the package contains instead of assuming it is absent. Call this before import_evidence, and pass the `path` values back verbatim.',
    parameters: {
      type: 'object',
      properties: {
        subdir: { type: 'string', description: 'Optional subdirectory to list, relative to the evidence folder (e.g. "HOST-A"). Omit to list everything.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'import_evidence',
    description:
      'Import evidence into the open case, as sources you can then query. NORMALLY pass `hosts` — the host names from list_evidence (e.g. ["host-a","host-b"]) — which imports EVERY artifact those hosts produced. Prefer that: you cannot know which artifact answers the question before you read it, and a journal that looks redundant with the $MFT is exactly where deleted-file residue survives. Use `paths` only for ungrouped files at the evidence root, or when you can say specifically why a host artifact is not needed — a partial import reports what it left behind, and you must justify those omissions in your report. Import in ONE call — each call asks the analyst to approve, so importing a 60-file triage package one file at a time means 60 interruptions. Each source is automatically assigned the HOST group from its subdirectory, so cross-host corroboration works immediately, and a filename that collides with an existing source (two hosts both have "Amcache.csv") is stored under a host-qualified label. ONLY tabular text (.csv, .tsv, .txt, .log) and Excel workbooks (.xlsx, .xlsm) can be imported — a workbook lands one source PER WORKSHEET. Anything else (a SQLite database, a raw .evtx, an image, an archive) is REFUSED with a reason explaining what it is and what would make it importable; do not try to work around that by renaming or re-passing it. Files that fail are reported per-file in `failed` and do NOT abort the rest of the import — always check `failed` and tell the analyst what did not land, rather than reporting the case as fully loaded.',
    parameters: {
      type: 'object',
      properties: {
        hosts: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Host names from list_evidence (its `groups`). Imports EVERY importable artifact under those hosts — the normal way to load a case, because it removes the guess about which artifact will matter.'
        },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Specific paths relative to the evidence folder, from list_evidence. For ungrouped root-level files, or a deliberate partial import you can justify. The result names any artifacts of a touched host that you did NOT take.'
        },
        group: {
          type: 'string',
          description: 'Optional host/system label to apply to ALL imported files, overriding the subdirectory-derived one. Only pass this when the directory layout does not reflect the host.'
        }
      },
      // Neither is required on its own — `hosts` is the normal call, `paths` the deliberate exception.
      // The executor rejects a call carrying neither, with a message naming both.
      additionalProperties: false
    }
  },
  {
    name: 'query_sql',
    description:
      "Run ONE read-only SQL SELECT across the open case. Use it for questions the other tools cannot express: correlating ACROSS sources in one shot (UNION/JOIN between two hosts' artifacts), numeric ordering (ORDER BY CAST(col AS INTEGER) — columns are stored as TEXT, so a plain sort is alphabetical: 1, 10, 2), or aggregates the `aggregate` tool cannot shape. Each source is a TABLE named data_<n>: get the exact name from describe_workspace (`table`), whose column ids c0…cN ARE the real SQL column names. Every table has an implicit `rowid` — select it when you need to identify specific rows. STRICTLY read-only: one SELECT (or WITH … SELECT); ATTACH, PRAGMA and any write are refused. Results are capped and long cells clipped, so AGGREGATE rather than listing when you expect many rows. Every query you run — including refused ones — is recorded in the case for the analyst to review. This tool records no findings: cite evidence through record_event so it stays validated and pivotable.",
    parameters: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: "A single SELECT (or WITH … SELECT) against the open case's data_<n> tables." },
        limit: { type: 'number', description: 'Max rows to return (default and maximum 200).' }
      },
      required: ['sql'],
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

// ---- Grounding validation ----

export interface ValidatedGrounding {
  sourceId: number
  sourceName: string
  matched: string
  count: number
  rids: number[]
  spans: ColSpan[]
  tsMin: number | null
  tsMax: number | null
  /** The item's per-row rationale, carried through for record_event to store. */
  why?: string | null
  /** The model asserting the WIDTH is the finding (record_event only) — kept so the caller can layer
   *  its wide-evidence check on the shared result rather than re-running the loop. */
  breadthIntended?: boolean
}

export interface GroundingResult {
  grounding: ValidatedGrounding[]
  rejected: Array<{ source: unknown; matched?: string; reason: string }>
  timeAnomalies: string[]
}

/**
 * The technique-resolution feedback block, shared by record_event and update_event.
 *
 * Returns {} when no technique was supplied; otherwise reports `techniqueVerified`, and — when the
 * catalog UPGRADED a retired id or FAILED to resolve one — a plain-language note. record_event was
 * hardened to announce these (an unannounced upgrade reads as the app silently rewriting the agent's
 * input; an unresolved id stored silently ships an unattributed event); update_event must say the same,
 * or a correction re-opens the exact failure. `raw` is undefined when the caller left the field alone.
 */
function techniqueReport(raw: string | undefined, resolved: ReturnType<typeof resolveTechnique> | null): Record<string, unknown> {
  if (raw === undefined) return {}
  return {
    techniqueVerified: resolved?.verified === true,
    ...(resolved?.supersededFrom
      ? {
          techniqueUpgraded: `ATT&CK ${ATTACK_VERSION} retired ${resolved.supersededFrom}; it is now ${resolved.id} — ${resolved.name}. Your citation was recognised and upgraded, not rejected. Cite the new id in your report.`
        }
      : {}),
    ...(resolved?.verified === true
      ? {}
      : {
          techniqueProblem: `"${raw}" did not resolve to a known ATT&CK technique, so it was stored verbatim and this event is NOT attributed. Pass a technique id (e.g. "T1685.005") or its exact name, then update_event to correct it.`
        })
  }
}

/**
 * Resolve a list of {source, value|search|filters} claims against the REAL rows, or reject each with a
 * reason the agent can act on.
 *
 * This is the rule that keeps the case honest — an assertion is only recorded once rows back it — so
 * leads and entities share one implementation rather than two that can drift apart. A claim matching
 * zero rows is never silently dropped; it comes back in `rejected` saying why.
 */
async function validateGrounding(
  ws: WsCtx,
  items: Array<Record<string, unknown>>,
  examined: (sourceId: number) => void
): Promise<GroundingResult> {
  const grounding: ValidatedGrounding[] = []
  const rejected: Array<{ source: unknown; matched?: string; reason: string }> = []
  const timeAnomalies: string[] = []
  for (const item of items) {
    let src: WsSource
    try {
      src = resolveSource(ws, item.source)
    } catch (e) {
      rejected.push({ source: item.source ?? '(none)', reason: e instanceof Error ? e.message : String(e) })
      continue
    }
    examined(src.sourceId)
    let windowFilter: unknown[]
    try {
      windowFilter = timeWindowFilter(src, item)
    } catch (e) {
      rejected.push({ source: pathOf(src), matched: String(item.value ?? item.search ?? 'filter'), reason: e instanceof Error ? e.message : String(e) })
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
      // Validate the model's own clauses strictly first (a dropped one would silently widen the
      // evidence), then merge the time window and normalize the combined set.
      const base = item.filters ? (strictFilters(item.filters, src.columns) as unknown[]) ?? [] : []
      const merged = [...base, ...windowFilter]
      const filters = merged.length ? normalizeFilters(merged as never) : undefined
      const search = typeof item.search === 'string' && item.search.trim() ? item.search.trim() : undefined
      if (!filters && !search) {
        rejected.push({ source: pathOf(src), reason: 'no value, search, or filters supplied for this grounding item' })
        continue
      }
      count = (await dbw.count(src.tabId, reqSeq++, filters, search ?? '', () => {})) ?? 0
      const page = (await dbw.call('queryRows', src.tabId, normalizeOpts({ filters, search, limit: CANDIDATE_CAP, offset: 0 } as never))) as { rids: number[]; rows: string[][] }
      rids = page.rids ?? []
      rows = page.rows ?? []
      // Human-readable criteria (headers, not c-ids) so the analyst sees WHAT selected these rows
      // and the agent can audit its own basis — replaces the old opaque literal "filter".
      matched = describeCriteria(filters, search, src.columns) || 'filter'
    }
    if (rids.length === 0) {
      rejected.push({ source: pathOf(src), matched: matched || value, reason: `matched 0 rows in ${src.name} — check the search term, source, or column` })
      continue
    }
    const spans = spansByColumn(src, rows, item.time_column)
    const { tsMin, tsMax } = envelopeOf(spans)
    // An impossible timestamp (epoch sentinel, or future-dated like a forged PE link date) is kept out
    // of the span so it can't anchor the Timeline — but it is REPORTED, because a bogus timestamp is
    // itself forensically interesting (timestomping).
    for (const bad of implausibleSpans(spans)) {
      timeAnomalies.push(`${src.name}: ${bad.kind} = ${isoUtc(bad.tsMin)}${bad.tsMax !== bad.tsMin ? `…${isoUtc(bad.tsMax)}` : ''}`)
    }
    grounding.push({
      sourceId: src.sourceId,
      sourceName: pathOf(src),
      matched,
      count,
      rids: rids.slice(0, EVIDENCE_RID_CAP),
      spans,
      tsMin,
      tsMax,
      // Carried for record_event; leads/entities simply ignore these.
      why: typeof item.why === 'string' && item.why.trim() ? item.why.trim() : null,
      breadthIntended: item.breadth_intended === true
    })
  }
  return { grounding, rejected, timeAnomalies }
}

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
  // A fan-out search that RETURNED ROWS from a source is not triage, but it is not nothing either:
  // the agent has seen some of that source's data. Tracked separately so review_coverage can stop
  // calling those "never touched" while still pushing the agent to open them properly.
  const glimpsed = (sourceId: number): void => {
    coverage?.seenInSearch.add(sourceId)
  }
  // Run the tool, then centrally stamp the workspace onto its result (#12): a terminal-driven caller
  // always sees which workspace it operated on, so it can't silently drift when the analyst switches
  // the active tab underneath it (and a write can't land on the wrong host unnoticed).
  const outcome: ToolOutcome = await (async (): Promise<ToolOutcome> => {
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
      const columns = src.columns.map((c) => ({
        id: c.name,
        label: c.original,
        ...(c.time ? { time: c.time } : {}),
        // Surfaced so the agent knows an order_by on this column compares numerically, and that
        // a CAST is unnecessary when it writes the same ordering in query_sql.
        ...(c.numeric ? { numeric: true } : {})
      }))
      return {
        // `table` is what query_sql needs. The column ids (c0…cN) ARE the real SQL column names, so
        // one schema read is enough to write a query against this source without guessing.
        result: { source: pathOf(src), table: tableOf(src), rowCount: src.rowCount, columns },
        card: `described "${src.name}" — ${src.rowCount} rows, ${columns.length} cols`
      }
    }

    case 'query_workspace': {
      const src = resolveSource(ws, args.source)
      examined(src.sourceId)
      const filters = strictFilters(args.filters, src.columns)
      const search = typeof args.search === 'string' && args.search.trim() ? args.search.trim() : undefined
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), SAMPLE_CAP)
      const pick = pickColumns(src.columns, args.columns)
      // order_by + order → sorted sample, so "earliest N events" is one call (ORDER BY time ASC LIMIT).
      const sort = sortFromArgs(src, args.order_by, args.order)

      // Exact match count only when constrained; an unconstrained query is just the source row count.
      let matchCount: number | null
      if (filters || search) {
        matchCount = await dbw.count(src.tabId, reqSeq++, filters, search ?? '', () => {})
      } else {
        matchCount = src.rowCount
      }

      // Paging. Without it only the first `limit` rows of a match were EVER reachable: a 275-row
      // burst could not be walked, and narrowing filters until a set fell under the cap was the only
      // way through — which changes the question being asked.
      const offset = Math.max(0, Math.trunc(Number(args.offset)) || 0)
      const page = (await dbw.call('queryRows', src.tabId, normalizeOpts({ filters, search, sort, limit, offset } as never))) as {
        rows: string[][]
        rids: number[]
      }
      const shownRows = page.rows ?? []
      const bulkyQ = pick ? new Set<number>() : bulkyColumns(shownRows, src.columns)
      const projQ = pick ?? (bulkyQ.size ? new Set(src.columns.map((_, i) => i).filter((i) => !bulkyQ.has(i))) : undefined)
      const sample = shownRows.map((r) => rowToObject(r, src.columns, CELL_CAP, projQ))
      const nextOffset = offset + sample.length
      const more = matchCount != null && nextOffset < matchCount
      return {
        result: {
          source: pathOf(src),
          matchCount,
          ...(sort ? { orderedBy: src.columns.find((c) => c.name === sort.col)?.original ?? sort.col, order: sort.dir } : {}),
          offset,
          sampleSize: sample.length,
          ...(bulkyQ.size ? { omittedColumns: droppedNames(src.columns, bulkyQ), omittedNote: 'Large columns were left out of this sample to keep it readable — pass `columns` to include them.' } : {}),
          // Spell out the next call rather than leaving the agent to infer that paging exists.
          ...(more ? { nextOffset, more: `Showing ${offset + 1}-${nextOffset} of ${matchCount}. Call again with offset: ${nextOffset} for the next page.` } : {}),
          sample
        },
        card: `query_workspace [${src.name}]${sort ? ` sorted ${sort.dir}` : ''}${offset ? ` @${offset}` : ''} → ${matchCount ?? '?'} rows match`
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

      const pick = pickColumns(src.columns, args.columns)
      const shown = m.rows.slice(0, SAMPLE_CAP)
      // Default projection only when the caller didn't name columns. The column the search was
      // restricted to is always kept — dropping the one holding the match would show rows that
      // appear not to contain what was searched for.
      const keepIdx = new Set<number>()
      if (m.colLabel) {
        const ki = src.columns.findIndex((c) => c.original === m.colLabel)
        if (ki >= 0) keepIdx.add(ki)
      }
      const bulky = pick ? new Set<number>() : bulkyColumns(shown, src.columns, keepIdx)
      const proj = pick ?? (bulky.size ? new Set(src.columns.map((_, i) => i).filter((i) => !bulky.has(i))) : undefined)
      const sample = shown.map((r) => rowToObject(r, src.columns, CELL_CAP, proj))
      const timed = timeFilters.length > 0
      // An empty TIME-FILTERED result is the one that misleads: "0 rows" reads as a true negative,
      // when the usual cause is filtering on a column that doesn't mean what the caller assumed (an
      // AppCompatCache LastModifiedTimeUTC is the BINARY's mtime, so a March-2025 window legitimately
      // matches nothing). Say which column was used, what it actually spans, and whether the value
      // exists at all outside the window — that turns a dead end into a diagnosis.
      const emptyWindow = timed && matchCount === 0 ? await explainEmptyWindow(src, value, args) : undefined
      return {
        result: { source: pathOf(src), value, matchType: m.matchType, ...(m.colLabel ? { column: m.colLabel } : {}), ...(timed ? { timeWindowApplied: true } : {}), matchCount, sampleSize: sample.length, ...(bulky.size ? { omittedColumns: droppedNames(src.columns, bulky), omittedNote: 'Large columns were left out of this sample to keep it readable — pass `columns` to include them.' } : {}), sample, ...(emptyWindow ? { emptyWindow } : {}), ...(note ? { note } : {}) },
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
      const perSource: Array<{ source: string; matchCount: number; sampleSize: number; omittedColumns?: string[]; sample: Record<string, string>[] }> = []
      // Cheap path: a CONTAINS count per source (no candidate pull) + a tiny sample. Precise whole-token
      // counts are the job of find_rows on a specific source; here we just locate where the value occurs.
      for (const src of scope) {
        const matchCount = (await dbw.count(src.tabId, reqSeq++, undefined, value, () => {})) ?? 0
        if (matchCount === 0) continue
        const page = (await dbw.call('queryRows', src.tabId, normalizeOpts({ search: value, limit: ALL_SAMPLE, offset: 0 } as never))) as { rows: string[][] }
        const rowsA = page.rows ?? []
        const bulkyA = bulkyColumns(rowsA, src.columns)
        const projA = bulkyA.size ? new Set(src.columns.map((_, i) => i).filter((i) => !bulkyA.has(i))) : undefined
        const sample = rowsA.map((r) => rowToObject(r, src.columns, CELL_CAP, projA))
        if (sample.length > 0) glimpsed(src.sourceId)
        perSource.push({ source: pathOf(src), matchCount, sampleSize: sample.length, ...(bulkyA.size ? { omittedColumns: droppedNames(src.columns, bulkyA) } : {}), sample })
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
          result: { source: pathOf(src), rowCount: src.rowCount, rows: [], note: `"${src.name}" has ${src.rowCount} rows (> ${FULL_READ_CAP}) — too large to read in full. Use find_rows or query_workspace to target the rows you need.` },
          card: `get_all_rows [${src.name}] → too large (${src.rowCount} rows)`
        }
      }
      examined(src.sourceId)
      const pick = pickColumns(src.columns, args.columns)
      const page = (await dbw.call('queryRows', src.tabId, normalizeOpts({ limit: FULL_READ_CAP, offset: 0 } as never))) as { rows: string[][] }
      const rows = (page.rows ?? []).map((r) => rowToObject(r, src.columns, FULL_CELL_CAP, pick))
      return { result: { source: pathOf(src), rowCount: src.rowCount, rowsReturned: rows.length, rows }, card: `get_all_rows [${src.name}] → ${rows.length} row(s)` }
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
      const perSource: Array<{ source: string; timeColumn: string; matchCount: number; sampleSize: number; omittedColumns?: string[]; sample: Record<string, string>[] }> = []
      const skipped: Array<{ source: string; reason: string }> = []
      for (const src of scope) {
        const cols = timeColumnsOf(src)
        if (cols.length === 0) {
          skipped.push({ source: pathOf(src), reason: 'no time column' })
          continue
        }
        if (cols.length > 1) {
          skipped.push({ source: pathOf(src), reason: `multiple time columns (${cols.map((c) => `${c.label}=${c.id}`).join(', ')}) — use find_rows with time_from/time_to + time_column` })
          continue
        }
        const tc = cols[0]
        const filters = normalizeFilters([{ col: tc.id, op: 'timerange', tkind: tc.kind, from, to }] as never)
        const search = value || undefined
        const matchCount = (await dbw.count(src.tabId, reqSeq++, filters, search ?? '', () => {})) ?? 0
        if (matchCount === 0) continue
        const page = (await dbw.call('queryRows', src.tabId, normalizeOpts({ filters, search, limit: ALL_SAMPLE, offset: 0 } as never))) as { rows: string[][] }
        const rowsA = page.rows ?? []
        const bulkyA = bulkyColumns(rowsA, src.columns)
        const projA = bulkyA.size ? new Set(src.columns.map((_, i) => i).filter((i) => !bulkyA.has(i))) : undefined
        const sample = rowsA.map((r) => rowToObject(r, src.columns, CELL_CAP, projA))
        if (sample.length > 0) glimpsed(src.sourceId)
        perSource.push({ source: pathOf(src), timeColumn: tc.label, matchCount, sampleSize: sample.length, ...(bulkyA.size ? { omittedColumns: droppedNames(src.columns, bulkyA) } : {}), sample })
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
        return { result: { tagged: m.rids.length, tag, value, source: pathOf(src), attributedTo: 'ai', complete: m.complete }, card: `tag_rows [${src.name}] → tagged ${m.rids.length} as ${tagLabel(tag)}` }
      }

      // Filter/search mode — tags the whole match set (substring), not just a page.
      const filters = strictFilters(args.filters, src.columns)
      const search = typeof args.search === 'string' && args.search.trim() ? args.search.trim() : undefined
      if (!filters && !search) throw new Error('Provide a value, or filters/search, to choose which rows to tag.')
      const count = (await dbw.count(src.tabId, reqSeq++, filters, search ?? '', () => {})) ?? 0
      const approved = await deps.requestApproval({ kind: 'tag', tag, count, summary: `Tag ${count} row(s) in ${src.name} matching the current criteria as ${tagLabel(tag)}`, detail: benignNote(tag) || undefined })
      if (!approved) return { result: { tagged: 0, declined: true }, card: `tag_rows → declined` }
      const res = (await dbw.call('tagByFilter', ws.wsId, src.sourceId, filters, search, tag, 'ai')) as { count: number }
      await dbw.call('aiMarkByFilter', ws.wsId, src.sourceId, filters, search, `Tagged ${tagLabel(tag)}`) // also ✨-mark
      return { result: { tagged: res.count, tag, source: pathOf(src), attributedTo: 'ai' }, card: `tag_rows [${src.name}] → tagged ${res.count} as ${tagLabel(tag)}` }
    }

    case 'set_source_group': {
      const src = resolveSource(ws, args.source)
      if (ws.wsId == null) throw new Error('This workspace cannot be grouped (no workspace id).')
      if (!deps?.requestApproval) throw new Error('Grouping needs user confirmation, which is unavailable in this run.')
      const group = typeof args.group === 'string' && args.group.trim() ? args.group.trim().slice(0, 120) : null
      const prev = src.group ?? null
      if (group === prev) {
        return { result: { changed: false, source: pathOf(src), group, reason: 'already in this group' }, card: `set_source_group [${src.name}] → already ${group ?? 'ungrouped'}` }
      }
      const summary = group
        ? `Group source "${src.name}" as ${group}${prev ? ` (was ${prev})` : ''}`
        : `Remove source "${src.name}" from its group${prev ? ` (${prev})` : ''}`
      const approved = await deps.requestApproval({ kind: 'group', sourceId: src.sourceId, group, summary, detail: 'Sets the host/system this artifact is attributed to (the Timeline\'s Host).' })
      if (!approved) return { result: { changed: false, declined: true, source: src.name }, card: `set_source_group → declined` }
      await dbw.call('setSourceGroup', ws.wsId, src.sourceId, group)
      src.group = group // mirror into this run's context so later tools (list_sources) see it immediately
      return { result: { changed: true, source: pathOf(src), group, previous: prev }, card: `set_source_group [${src.name}] → ${group ?? 'ungrouped'}` }
    }

    case 'mark_rows': {
      const src = resolveSource(ws, args.source)
      examined(src.sourceId)
      if (ws.wsId == null) throw new Error('This workspace cannot be marked (no workspace id).')
      const note = typeof args.note === 'string' && args.note.trim() ? args.note.trim().slice(0, 300) : null
      const value = String(args.value ?? '').trim()
      if (value) {
        const m = await findMatches(src, value, args.column)
        if (m.rids.length === 0) return { result: { marked: 0, value, source: pathOf(src) }, card: `mark_rows [${src.name}] "${value}" → no matches` }
        const res = (await dbw.call('setAiMarks', ws.wsId, src.sourceId, m.rids, note)) as { count: number }
        return { result: { marked: res.count, value, note, source: pathOf(src) }, card: `✨ marked ${res.count} row(s) in ${src.name} for "${value}"` }
      }
      const filters = strictFilters(args.filters, src.columns)
      const search = typeof args.search === 'string' && args.search.trim() ? args.search.trim() : undefined
      if (!filters && !search) throw new Error('Provide a value, or filters/search, to choose which rows to mark.')
      const res = (await dbw.call('aiMarkByFilter', ws.wsId, src.sourceId, filters, search, note)) as { count: number }
      return { result: { marked: res.count, note, source: pathOf(src) }, card: `✨ marked ${res.count} row(s) in ${src.name}` }
    }

    case 'record_event': {
      if (!ws.hasWorkspace || ws.wsId == null || ws.sources.length === 0) throw new Error('No workspace is open.')
      const warnings: string[] = []
      const label = clipField(args.label, 300, 'label', warnings) ?? ''
      if (!label) throw new Error('record_event needs a label (the action/event that occurred).')
      // undefined = leave whatever is already recorded (a corroboration merge must not wipe it).
      const description = args.description !== undefined ? clipField(args.description, 2000, 'description', warnings) : undefined
      // Same omit/null contract as description: undefined leaves whatever is recorded, so adding
      // corroboration to an event never silently erases the doubt someone recorded about it.
      const uncertainty = args.uncertainty !== undefined ? clipField(args.uncertainty, 2000, 'uncertainty', warnings) : undefined
      // Ground the cited technique against the ATT&CK catalog (canonicalize known ones; keep + flag unknown).
      const rawTechnique = args.technique !== undefined ? clipField(args.technique, 200, 'technique', warnings) : undefined
      const resolvedTechnique = rawTechnique ? resolveTechnique(rawTechnique) : null
      const technique = rawTechnique === undefined ? undefined : resolvedTechnique ? resolvedTechnique.display : rawTechnique
      // Curated user attribution — only set when the model supplied it (undefined leaves any prior set
      // untouched on a merge-re-record; the db normalizes/dedups/caps).
      const users = Array.isArray(args.users) ? args.users.map((u) => String(u ?? '').trim()).filter(Boolean) : undefined
      const items = Array.isArray(args.evidence) ? (args.evidence as Array<Record<string, unknown>>) : []
      if (items.length === 0) throw new Error('record_event needs evidence (the rows that corroborate the event).')
      // Opt-outs: acknowledge the corroboration check, and REPLACE this event's evidence instead of
      // merging (so a re-record with tighter scoping drops the earlier sloppy item).
      const corroborationChecked = args.corroboration_checked === true
      const replaceEvidence = args.replace_evidence === true

      // Validate every evidence item against the real rows via the SHARED validateGrounding — the same
      // honesty gate record_lead and record_entity use. record_event's only additions are ✨-marking
      // the exact stored rows and carrying breadth_intended/why, both of which ride on the result now,
      // so this no longer keeps a second copy of the loop that could drift from the others.
      const { grounding, rejected, timeAnomalies } = await validateGrounding(ws, items, examined)
      const evidence = grounding.map((g) => ({
        sourceId: g.sourceId,
        sourceName: g.sourceName,
        matched: g.matched,
        count: g.count,
        rids: g.rids,
        spans: g.spans,
        tsMin: g.tsMin,
        tsMax: g.tsMax,
        why: g.why ?? null,
        breadthIntended: g.breadthIntended === true
      }))
      // ✨-mark EXACTLY the rows stored as evidence, labelled so the analyst can see why a row is
      // marked: it backs this event on the Timeline.
      for (const g of evidence) {
        await dbw.call('setAiMarks', ws.wsId, g.sourceId, g.rids, `Timeline evidence: ${label}`)
      }

      if (evidence.length === 0) {
        return {
          result: { recorded: false, label, reason: 'None of the evidence matched any rows — event not recorded (it must be backed by real rows). See `rejected` for why each item failed, then fix and retry.', rejected },
          card: `record_event "${label}" → no evidence matched (not recorded)`
        }
      }

      const id = `event:${label.toLowerCase().replace(/\s+/g, '-').slice(0, 80)}`
      await dbw.call('recordEvent', ws.wsId, { id, label, description, technique, users, uncertainty }, evidence, 'ai', replaceEvidence)
      if (coverage) coverage.recordedEvents++ // a concluded event marks this run as a triage (drives coverage nudges)

      // Read back the event's CUMULATIVE evidence (this call is additive/merged), so coverage reflects
      // everything corroborating the event so far — not just this call's pieces.
      const allEvents = (await dbw.call('listEvents', ws.wsId)) as Array<{ id: string; evidence: Array<{ sourceId: number; sourceName: string; matched: string; count: number }> }>
      const thisEvent = allEvents.find((e) => e.id === id)
      const citedIds = new Set((thisEvent?.evidence ?? evidence).map((e) => e.sourceId))
      const sources = [...new Set((thisEvent?.evidence ?? evidence).map((e) => e.sourceName))]

      // Coverage nudge: forensic events usually leave traces across MANY artifacts. We can't know how
      // many an event SHOULD touch, so the stop point scales with how many sources are loaded — keep
      // nudging until the event cites ~a quarter of them (floored at 2 so tiny workspaces aren't nagged,
      // and never nudging past what's actually un-cited). Below that, name the un-cited sources so the
      // model corroborates there (or confirms it checked and they're clean) and calls record_event again.
      // Scope corroboration to the event's OWN host group. Suggesting another host's artifacts would
      // pull them into a host-scoped event — exactly what the scoping rules warn against — and the
      // whole-workspace denominator ("1 of 59") is meaningless when the event belongs to one host.
      const citedGroups = new Set(ws.sources.filter((s) => citedIds.has(s.sourceId)).map((s) => s.group ?? null))
      const scopeGroup = citedGroups.size === 1 ? [...citedGroups][0] : null
      const scopeSrc = scopeGroup != null ? ws.sources.filter((s) => (s.group ?? null) === scopeGroup) : ws.sources
      const scopeLabel = scopeGroup != null ? ` ${scopeGroup}` : ''
      const uncitedSrc = scopeSrc.filter((s) => !citedIds.has(s.sourceId))
      const corroborationTarget = Math.max(2, Math.ceil(scopeSrc.length / 4))
      // Suggest only the artifacts where this KIND of action plausibly leaves a trace (execution, file,
      // persistence, remote access), falling back to the biggest un-cited sources. Capped hard: dumping
      // every un-cited name made this nudge the bulk of the tool output, and it read identically whether
      // the event was genuinely under-corroborated or simply only observable in one artifact.
      // Ranked by what THIS event is: the resolved technique's ATT&CK tactics decide which artifact
      // families could actually evidence it (see ai/corroborate). Suggesting Amcache for a network
      // logon is why the agent stopped reading this field.
      const likely = corroborationCandidates(uncitedSrc, resolvedTechnique?.tactics ?? []).map((s) => pathOf(s))
      const corroboration =
        !corroborationChecked && uncitedSrc.length > 0 && citedIds.size < corroborationTarget
          ? `Cites ${citedIds.size} of ${scopeSrc.length}${scopeLabel} sources. If this action would leave a trace elsewhere, check it and re-record with the same label (evidence merges). Not every event lives in every source — pass corroboration_checked: true to acknowledge you've considered it. Worth a look: ${likely.map((n) => n).join(', ')}.`
          : undefined

      // Wide-evidence nudge: an evidence item matching many rows means the Timeline entry represents ALL
      // of them (and a pivot lands on all), with the displayed time just the earliest. Tell the model so
      // it re-records with tighter scoping (column / time_from-to / an exact path) for a precise entry.
      const WIDE = 25
      const wide = evidence.filter((e) => e.count > WIDE && !e.breadthIntended).map((e) => `"${e.matched}" in ${e.sourceName} → ${e.count} rows`)
      const wideEvidence =
        wide.length > 0
          ? `Some evidence matched MANY rows, so that Timeline entry represents all of them at once (the shown time is just the earliest): ${wide.join('; ')}. Re-record those with tighter scoping — a column, a time_from/time_to window, or an exact path/value — so each entry pins to the specific rows. If the WIDTH is the finding (e.g. "275 channels cleared"), pass breadth_intended: true on that evidence item instead.`
          : undefined

      return {
        result: {
          recorded: true,
          label,
          technique,
          // Three distinct outcomes, not two. `null` used to mean BOTH "no technique supplied" and
          // "supplied but it didn't resolve" — so a dropped ATT&CK attribution looked identical to
          // never having cited one, and four events nearly shipped unattributed on the strength of
          // `recorded: true`. Say which happened, and why.
          ...techniqueReport(rawTechnique ?? undefined, resolvedTechnique),
          evidenceCount: thisEvent?.evidence.length ?? evidence.length,
          sources,
          // Whether this call MERGED into existing evidence or replaced it, plus the event's CURRENT
          // evidence — so a re-record with tighter scoping doesn't silently leave the sloppy item attached.
          mode: replaceEvidence ? 'replaced' : 'merged',
          evidence: (thisEvent?.evidence ?? evidence).map((e) => ({ source: e.sourceName, matched: e.matched, rows: e.count })),
          ...(rejected.length ? { rejected } : {}),
          ...(warnings.length ? { warnings } : {}),
          ...(timeAnomalies.length
            ? {
                timeAnomalies,
                timeAnomalyNote:
                  'These timestamps are impossible for collected evidence (epoch sentinel or future-dated), so they are excluded from this event’s time span — the rows are still evidence. A bogus timestamp can itself be a finding (timestomping, a forged PE link date): consider whether it is worth investigating.'
              }
            : {}),
          ...(wideEvidence ? { wideEvidence } : {}),
          ...(corroboration ? { corroboration } : {})
        },
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

    case 'record_lead': {
      if (!ws.hasWorkspace || ws.wsId == null || ws.sources.length === 0) throw new Error('No workspace is open.')
      const warnings: string[] = []
      const statement = clipField(args.statement, 500, 'statement', warnings) ?? ''
      if (!statement) throw new Error('record_lead needs a statement (the hypothesis/inference).')
      // why_uncertain carries the calibration reasoning a grader needs — generous cap, never silent.
      const whyUncertain = clipField(args.why_uncertain, 2000, 'why_uncertain', warnings)
      const nextStep = clipField(args.next_step, 1000, 'next_step', warnings)
      const items = Array.isArray(args.grounding) ? (args.grounding as Array<Record<string, unknown>>) : []
      if (items.length === 0) throw new Error('record_lead needs grounding — a lead must cite the real rows that prompted it.')

      // Validate each grounding item against the data, exactly like record_event's evidence — a lead is
      // only recorded if real rows back it (no ungrounded hunches). Spans are captured so a promoted lead
      // becomes a dated event.
      const { grounding, rejected, timeAnomalies } = await validateGrounding(ws, items, examined)

      if (grounding.length === 0) {
        return {
          result: { recorded: false, statement, reason: 'None of the grounding matched any rows — lead not recorded (a lead must cite real rows). See `rejected` for why, then fix and retry.', rejected },
          card: `record_lead "${statement}" → no grounding matched (not recorded)`
        }
      }
      const id = `lead:${statement.toLowerCase().replace(/\s+/g, '-').slice(0, 80)}`
      await dbw.call('recordLead', ws.wsId, { id, statement, whyUncertain, nextStep }, grounding)
      return {
        result: {
          recorded: true,
          statement,
          groundingCount: grounding.length,
          sources: [...new Set(grounding.map((g) => g.sourceName))],
          ...(warnings.length ? { warnings } : {}),
          ...(rejected.length ? { rejected } : {}),
          ...(timeAnomalies.length ? { timeAnomalies } : {}),
          note: 'Recorded as a LEAD (an unproven hypothesis) in the Investigation panel — NOT an event. Promote it to an event with record_event once you confirm it.'
        },
        card: `◇ lead "${statement}" — ${grounding.length} grounding item(s)`
      }
    }

    case 'update_event': {
      if (!ws.hasWorkspace || ws.wsId == null) throw new Error('No workspace is open.')
      const eventId = String(args.event_id ?? '').trim()
      if (!eventId) throw new Error('update_event needs an event_id (get it from list_events).')
      const cur = (await dbw.call('getEvent', ws.wsId, eventId)) as
        | { id: string; label: string; description: string | null; technique: string | null; actor: 'ai' | 'analyst' }
        | null
      if (!cur) throw new Error(`No event with id "${eventId}" — call list_events for the current ids.`)
      const warnings: string[] = []
      const nextLabel = args.label !== undefined ? clipField(args.label, 300, 'label', warnings) ?? cur.label : cur.label
      const nextDesc = args.description !== undefined ? clipField(args.description, 2000, 'description', warnings) : cur.description
      const rawTech = args.technique !== undefined ? clipField(args.technique, 200, 'technique', warnings) : cur.technique
      const resolved = rawTech ? resolveTechnique(rawTech) : null
      // `users` is only replaced when supplied; otherwise the event's existing set is preserved.
      const nextUsers = Array.isArray(args.users) ? args.users.map((u) => String(u ?? '').trim()).filter(Boolean) : undefined
      const existing = (await dbw.call('listEvents', ws.wsId)) as Array<{ id: string; users?: string[] }>
      const users = nextUsers ?? existing.find((e) => e.id === eventId)?.users ?? []
      // Omitted leaves the recorded doubt alone; an EMPTY STRING settles it. Correcting a label must
      // not silently erase the one field keeping a contested reading from looking like fact.
      const nextUncertainty =
        args.uncertainty === undefined ? undefined : clipField(args.uncertainty, 2000, 'uncertainty', warnings) || null
      const ok = (await dbw.call(
        'updateEvent',
        ws.wsId,
        eventId,
        { label: nextLabel, description: nextDesc, technique: resolved ? resolved.display : rawTech, users, uncertainty: nextUncertainty },
        'ai'
      )) as boolean
      if (!ok) throw new Error(`Event "${eventId}" could not be updated — the analyst has taken ownership of its interpretation.`)
      return {
        result: {
          updated: true,
          eventId,
          label: nextLabel,
          technique: resolved ? resolved.display : rawTech,
          // Same technique feedback record_event gives — so correcting a technique to an unresolvable
          // value no longer stores "X (unverified)" silently and re-opens the unattributed-event failure.
          ...techniqueReport(args.technique !== undefined ? (rawTech ?? undefined) : undefined, resolved),
          ...(warnings.length ? { warnings } : {}),
          note: 'Interpretation updated; evidence untouched. The id still reflects the original label.'
        },
        card: `event updated: ${nextLabel}`
      }
    }

    case 'list_events': {
      if (!ws.hasWorkspace || ws.wsId == null) throw new Error('No workspace is open.')
      const events = (await dbw.call('listEvents', ws.wsId)) as Array<{
        id: string
        label: string
        description: string | null
        technique: string | null
        users?: string[]
        hosts?: string[]
        uncertainty?: string | null
        evidence: Array<{ sourceName: string; matched: string; count: number; why?: string | null; tsMin: number | null; tsMax: number | null; spans?: Array<{ kind: string; tsMin: number; tsMax: number }> }>
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
          id: e.id,
          label: e.label,
          description: e.description,
          technique: e.technique,
          users: e.users ?? [],
          // What is UNSETTLED about it, when anything is. Absent means nothing was contested — not
          // that the reading is confirmed by omission.
          ...(e.uncertainty ? { uncertainty: e.uncertainty } : {}),
          // The host(s) this happened on, derived from the group of every source cited. Without it a
          // multi-host case reads as duplicates — three genuinely distinct per-host log-clearing
          // actions were indistinguishable in the Timeline without opening each one, and agents took
          // to smuggling the hostname into the label by hand.
          hosts: e.hosts ?? [],
          sourceCount: sources.length,
          sources,
          evidenceCount: e.evidence.length,
          // The exact value/search matched per source + its row count — so you can AUDIT what you cited
          // and CORROBORATE: take a key artifact you already matched and search for it in other sources.
          evidence: e.evidence.map((v) => ({ source: v.sourceName, matched: v.matched, rows: v.count, ...(v.why ? { why: v.why } : {}) })),
          timeSpan: lo != null && hi != null ? { start: isoUtc(lo), end: isoUtc(hi) } : null,
          times
        }
      })
      // Optional host scope — the reason to derive hosts at all is to be able to ask "what happened
      // on THIS machine" without re-reading every event.
      const wantHosts = (Array.isArray(args.hosts) ? args.hosts : []).map((h) => String(h ?? '').trim().toLowerCase()).filter(Boolean)
      const scoped = wantHosts.length ? items.filter((i) => i.hosts.some((h) => wantHosts.includes(h.toLowerCase()))) : items
      const unknownHosts = wantHosts.filter((h) => !items.some((i) => i.hosts.some((x) => x.toLowerCase() === h)))
      const byHost = new Map<string, number>()
      for (const i of scoped) for (const h of i.hosts.length ? i.hosts : ['(ungrouped)']) byHost.set(h, (byHost.get(h) ?? 0) + 1)
      return {
        result: {
          count: scoped.length,
          ...(wantHosts.length ? { hostFilter: wantHosts } : {}),
          ...(unknownHosts.length ? { unknownHosts, unknownHostsNote: 'No recorded event cites a source from these hosts — check list_sources for the exact group names.' } : {}),
          byHost: Object.fromEntries([...byHost.entries()].sort()),
          events: scoped
        },
        card: `list_events → ${scoped.length} event(s)${wantHosts.length ? ` on ${wantHosts.join(', ')}` : ''}`
      }
    }

    case 'list_iocs': {
      if (!ws.hasWorkspace || ws.wsId == null) throw new Error('No workspace is open.')
      const iocs = (await dbw.call('listIocs', ws.wsId)) as Array<{ value: string; type: string; context: string | null }>
      const items = iocs.map((i) => ({ value: i.value, type: IOC_TYPES[i.type] ?? i.type, context: i.context }))
      return { result: { count: items.length, iocs: items }, card: `list_iocs → ${items.length} IOC(s)` }
    }

    case 'update_lead': {
      if (!ws.hasWorkspace || ws.wsId == null) throw new Error('No workspace is open.')
      const leadId = String(args.lead_id ?? '').trim()
      if (!leadId) throw new Error('update_lead needs a lead_id (get it from list_leads).')
      const warnings: string[] = []
      const status = args.status === 'refuted' || args.status === 'superseded' || args.status === 'open' ? args.status : undefined
      const patch: Record<string, unknown> = {}
      if (status) patch.status = status
      if (args.resolution !== undefined) patch.resolution = clipField(args.resolution, 2000, 'resolution', warnings)
      if (args.superseded_by !== undefined) patch.supersededBy = String(args.superseded_by ?? '') || null
      if (args.statement !== undefined) patch.statement = clipField(args.statement, 500, 'statement', warnings)
      if (args.why_uncertain !== undefined) patch.whyUncertain = clipField(args.why_uncertain, 2000, 'why_uncertain', warnings)
      if (args.next_step !== undefined) patch.nextStep = clipField(args.next_step, 1000, 'next_step', warnings)
      if (Object.keys(patch).length === 0) throw new Error('update_lead needs something to change (status, resolution, or corrected text).')
      const ok = (await dbw.call('updateLead', ws.wsId, leadId, patch)) as boolean
      if (!ok) throw new Error(`No lead with id "${leadId}" — call list_leads for the current ids.`)
      return {
        result: { updated: true, leadId, ...(status ? { status } : {}), ...(warnings.length ? { warnings } : {}) },
        card: `lead ${status ? `→ ${status}` : 'updated'}: ${leadId}`
      }
    }

    case 'list_leads': {
      if (!ws.hasWorkspace || ws.wsId == null) throw new Error('No workspace is open.')
      const leads = (await dbw.call('listLeads', ws.wsId)) as Array<{
        id: string
        statement: string
        whyUncertain: string | null
        nextStep: string | null
        status: string
        resolution: string | null
        grounding: Array<{ sourceName: string; matched: string; count: number }>
      }>
      const items = leads.map((l) => ({
        id: l.id,
        status: l.status,
        ...(l.resolution ? { resolution: l.resolution } : {}),
        statement: l.statement,
        whyUncertain: l.whyUncertain,
        nextStep: l.nextStep,
        grounding: l.grounding.map((g) => ({ source: g.sourceName, matched: g.matched, rows: g.count }))
      }))
      const open = items.filter((l) => l.status === 'open').length
      return { result: { count: items.length, open, leads: items }, card: `list_leads → ${open} open of ${items.length}` }
    }

    case 'list_case_report': {
      if (!ws.hasWorkspace || ws.wsId == null) throw new Error('No workspace is open.')
      const all = (await dbw.call('listCaseReport', ws.wsId)) as CaseReportItem[]
      const wantVerdict = typeof args.verdict === 'string' ? args.verdict : null
      const wantHosts = (Array.isArray(args.hosts) ? args.hosts : []).map((h) => String(h ?? '').trim().toLowerCase()).filter(Boolean)
      let items = all
      if (wantVerdict) items = items.filter((i) => i.verdict === wantVerdict)
      if (wantHosts.length) items = items.filter((i) => i.hosts.some((h) => wantHosts.includes(h.toLowerCase())))

      const counts = { pending: 0, approved: 0, rejected: 0 }
      for (const i of all) counts[i.verdict]++
      const rejected = all.filter((i) => i.verdict === 'rejected')

      return {
        result: {
          count: items.length,
          totals: counts,
          items: items.map((i) => ({
            kind: i.kind,
            id: i.id,
            title: i.title,
            detail: i.detail,
            hosts: i.hosts,
            addedBy: i.actor,
            verdict: i.verdict,
            ...(i.reason ? { analystReason: i.reason } : {}),
            support: i.support,
            ...(i.flags.length ? { flags: i.flags } : {})
          })),
          // Surfaced whether or not it was asked for: a rejection the agent does not read is a
          // correction that never lands, and re-asserting a rejected claim is the failure this
          // whole layer exists to prevent.
          ...(rejected.length && wantVerdict !== 'rejected'
            ? {
                rejectedNote: `${rejected.length} claim(s) have been REJECTED by the analyst. Read them (verdict:"rejected") before recording anything further — do not re-assert a rejected claim, and treat the stated reason as a correction.`
              }
            : {}),
          ...(counts.pending > 0 ? { pendingNote: `${counts.pending} claim(s) are still awaiting the analyst's review.` } : {})
        },
        card: `list_case_report → ${items.length} claim(s) (${counts.pending} pending, ${counts.approved} approved, ${counts.rejected} rejected)`
      }
    }

    case 'record_negative': {
      if (!ws.hasWorkspace || ws.wsId == null) throw new Error('No workspace is open.')
      const warnings: string[] = []
      // NOT clipField: this text is the CLAIM the analyst approves or rejects in the Case Report, so a
      // sentence cut mid-word is worse than making you resend. Refuse and say the real length.
      const statement = String(args.statement ?? '').trim()
      if (!statement) throw new Error('record_negative needs a statement (the absence, stated plainly).')
      if (statement.length > NEGATIVE_STATEMENT_MAX) {
        throw new Error(
          `statement is ${statement.length} characters; the limit is ${NEGATIVE_STATEMENT_MAX}. It was NOT recorded — nothing was truncated. Re-send a shorter statement (put the supporting detail in why_it_matters, which allows 2000).`
        )
      }
      const kind = args.kind === 'gap' ? 'gap' : 'absence'
      const whyItMatters = clipField(args.why_it_matters, 2000, 'why_it_matters', warnings)
      const id = `negative:${statement.toLowerCase().replace(/\s+/g, '-').slice(0, 80)}`

      // A GAP is a claim about the evidence, not the intrusion — a parser that failed, an artifact
      // class nobody could parse. There is nothing to search, so it is stored as a statement and
      // never reported as machine-verifiable.
      if (kind === 'gap') {
        await dbw.call('recordNegative', ws.wsId, { id, kind, statement, whyItMatters }, { sourceIds: [] }, 'ai')
        return {
          result: {
            recorded: true,
            id,
            kind,
            statement,
            verifiable: false,
            ...(warnings.length ? { warnings } : {}),
            note: 'Recorded as an EVIDENCE GAP. It has no query behind it, so the app cannot re-check it — it stands on your description.'
          },
          card: `▽ gap "${statement}"`
        }
      }

      // A claim like "no .locked, .encrypted or .lockbit" must have checked EACH term — verifying one
      // and asserting three is how an absence ends up broader than what was searched. `values` takes
      // the whole list; `value` stays for the single-term case.
      const listed = (Array.isArray(args.values) ? args.values : []).map((v) => String(v ?? '').trim()).filter(Boolean)
      const single = String(args.value ?? '').trim()
      const terms = [...new Set([...listed, ...(single ? [single] : [])])]
      const search = typeof args.search === 'string' && args.search.trim() ? args.search.trim() : undefined
      const hasFilters = Array.isArray(args.filters) && args.filters.length > 0
      if (terms.length === 0 && !search && !hasFilters) {
        throw new Error(
          'record_negative needs something to have searched FOR — `value`, `search`, or `filters`. An absence with no query behind it is unfalsifiable; if you mean the evidence itself is missing or unparsed, pass kind:"gap".'
        )
      }

      // Which sources the claim covers. Explicit `sources` wins; otherwise every source, optionally
      // narrowed to `hosts`. The set actually searched is stored AS the claim's scope, because an
      // absence is only ever true relative to where you looked.
      const wantHosts = (Array.isArray(args.hosts) ? args.hosts : []).map((h) => String(h ?? '').trim()).filter(Boolean)
      const named = (Array.isArray(args.sources) ? args.sources : []).map((x) => String(x ?? '').trim()).filter(Boolean)
      let scoped: WsSource[]
      if (named.length) {
        scoped = named.map((n) => resolveSource(ws, n))
      } else {
        scoped = ws.sources.filter((s) => !wantHosts.length || wantHosts.some((h) => (s.group ?? '').toLowerCase() === h.toLowerCase()))
      }
      if (scoped.length === 0) {
        throw new Error(
          wantHosts.length
            ? `No loaded source belongs to ${wantHosts.join(', ')} — check list_sources for the host group names.`
            : 'There are no sources to search.'
        )
      }

      // Run it. A "negative" that MATCHES is not a negative — it is a discovery, and reporting it as
      // an absence would put a false clean-bill into the case. Refuse, and say exactly where it hit.
      // EVERY term must come back empty. One hit anywhere sinks the whole claim — and the refusal
      // names WHICH term hit where, so a three-extension claim that fails on one is actionable rather
      // than a flat "your search matched something".
      const hits: Array<{ term: string; source: string; rows: number }> = []
      let searched = 0
      for (const src of scoped) {
        examined(src.sourceId)
        let windowFilter: unknown[]
        try {
          windowFilter = timeWindowFilter(src, { time_from: args.time_from, time_to: args.time_to, time_column: args.time_column })
        } catch {
          // A source with no usable time column simply cannot honour the window. Searching it
          // unbounded would silently WIDEN the claim, so it is left out of scope instead.
          continue
        }
        searched++
        for (const term of terms) {
          const m = await findMatches(src, term, args.column, windowFilter)
          const rows = m.complete ? m.rids.length : m.substringCount
          if (rows > 0) hits.push({ term, source: pathOf(src), rows })
        }
        if (search || hasFilters) {
          const base = hasFilters ? (strictFilters(args.filters, src.columns) as unknown[]) ?? [] : []
          const merged = [...base, ...windowFilter]
          const filters = merged.length ? normalizeFilters(merged as never) : undefined
          const rows = (await dbw.count(src.tabId, reqSeq++, filters, search ?? '', () => {})) ?? 0
          if (rows > 0) hits.push({ term: search ?? 'filter', source: pathOf(src), rows })
        }
      }

      if (hits.length > 0) {
        const total = hits.reduce((n, h) => n + h.rows, 0)
        const badTerms = [...new Set(hits.map((h) => h.term))]
        return {
          result: {
            recorded: false,
            statement,
            reason: `NOT RECORDED — this is not an absence. ${badTerms.length === 1 ? `"${badTerms[0]}"` : `${badTerms.length} of the terms you searched (${badTerms.map((t) => `"${t}"`).join(', ')})`} matched ${total} row(s) across ${new Set(hits.map((h) => h.source)).size} source(s), so what you were about to record as missing is present.`,
            matchedTerms: badTerms,
            found: hits,
            note: 'Read those rows before concluding. If they are irrelevant, tighten the search and try again; if they are not, this is a finding, not a negative. If only SOME terms matched, the others may still be a valid narrower absence — record that instead of the broad claim.'
          },
          card: `record_negative "${statement}" → REFUSED, ${badTerms.join(', ')} matched ${total} row(s)`
        }
      }

      const scope = {
        sourceIds: scoped.map((s) => s.sourceId),
        hosts: wantHosts,
        values: terms,
        value: terms[0] ?? null,
        search: search ?? null,
        filters: hasFilters ? args.filters : null,
        timeFrom: args.time_from != null ? toEpochSeconds(String(args.time_from)) : null,
        timeTo: args.time_to != null ? toEpochSeconds(String(args.time_to)) : null,
        timeColumn: args.time_column != null ? String(args.time_column) : null
      }
      await dbw.call('recordNegative', ws.wsId, { id, kind, statement, whyItMatters }, scope, 'ai')
      const skipped = scoped.length - searched
      return {
        result: {
          recorded: true,
          id,
          kind,
          statement,
          searchedSources: searched,
          verifiedTerms: terms.length ? terms : undefined,
          ...(skipped > 0 ? { skippedSources: skipped, skippedNote: 'Sources with no time column usable for the requested window were left OUT of scope rather than searched unbounded, which would have widened the claim.' } : {}),
          ...(warnings.length ? { warnings } : {}),
          verifiable: true,
          note: `Recorded as a PROVEN ABSENCE over ${searched} source(s). The scope is stored with it, so verify_negative can re-run this later — and it is flagged stale once evidence arrives that this search never covered.`
        },
        card: `▽ absence "${statement}" — 0 rows across ${searched} source(s)`
      }
    }

    case 'verify_negative': {
      if (!ws.hasWorkspace || ws.wsId == null) throw new Error('No workspace is open.')
      const id = String(args.id ?? '').trim()
      if (!id) throw new Error('verify_negative needs an id (get it from list_negatives).')
      const all = (await dbw.call('listNegatives', ws.wsId)) as NegativeOut[]
      const neg = all.find((n) => n.id === id)
      if (!neg) throw new Error(`No negative with id "${id}" — call list_negatives for the current ids.`)
      if (!neg.verifiable) {
        return {
          result: { verified: false, id, reason: 'This is an evidence GAP, not a searched absence — there is no query to re-run. It stands on its description.' },
          card: `verify_negative → not verifiable (gap)`
        }
      }

      // Re-run over the CURRENT sources under the ORIGINAL scope rule. Hosts are re-resolved rather
      // than replaying the stored ids, because the whole point is to cover evidence that has arrived
      // since — replaying the old id list would re-confirm the claim against the very sources that
      // already agreed with it.
      const hosts = neg.scope.hosts ?? []
      const scoped = hosts.length
        ? ws.sources.filter((s) => hosts.some((h) => (s.group ?? '').toLowerCase() === h.toLowerCase()))
        : ws.sources
      const hits: Array<{ term: string; source: string; rows: number }> = []
      let searched = 0
      for (const src of scoped) {
        let windowFilter: unknown[]
        try {
          windowFilter = timeWindowFilter(src, {
            time_from: neg.scope.timeFrom ?? undefined,
            time_to: neg.scope.timeTo ?? undefined,
            time_column: neg.scope.timeColumn ?? undefined
          })
        } catch {
          continue
        }
        searched++
        // Re-run EVERY term the claim was built on, not just the first — otherwise a multi-term
        // absence would be re-confirmed on a fraction of what it asserts.
        for (const term of neg.scope.values ?? []) {
          const m = await findMatches(src, term, undefined, windowFilter)
          const rows = m.complete ? m.rids.length : m.substringCount
          if (rows > 0) hits.push({ term, source: pathOf(src), rows })
        }
        if (neg.scope.search || neg.scope.filters) {
          const base = neg.scope.filters ? (strictFilters(neg.scope.filters, src.columns) as unknown[]) ?? [] : []
          const merged = [...base, ...windowFilter]
          const filters = merged.length ? normalizeFilters(merged as never) : undefined
          const rows = (await dbw.count(src.tabId, reqSeq++, filters, neg.scope.search ?? '', () => {})) ?? 0
          if (rows > 0) hits.push({ term: neg.scope.search ?? 'filter', source: pathOf(src), rows })
        }
      }

      const total = hits.reduce((n, h) => n + h.rows, 0)
      await dbw.call('setNegativeVerification', ws.wsId, id, total)
      const newSources = searched - neg.scope.sourceIds.length
      if (total > 0) {
        return {
          result: {
            verified: true,
            stillHolds: false,
            id,
            statement: neg.statement,
            found: hits,
            rows: total,
            note: 'OVERTURNED — this absence no longer holds. The rows that broke it are listed; they are a finding, and anything you concluded from the absence needs revisiting.'
          },
          card: `⚠ verify_negative "${neg.statement}" → OVERTURNED (${total} row(s))`
        }
      }
      return {
        result: {
          verified: true,
          stillHolds: true,
          id,
          statement: neg.statement,
          searchedSources: searched,
          ...(newSources > 0 ? { newSourcesCovered: newSources } : {}),
          note: `Reconfirmed across ${searched} source(s)${newSources > 0 ? `, including ${newSources} imported since it was established` : ''}. No longer stale.`
        },
        card: `✓ verify_negative "${neg.statement}" → still holds`
      }
    }

    case 'list_negatives': {
      if (!ws.hasWorkspace || ws.wsId == null) throw new Error('No workspace is open.')
      const all = (await dbw.call('listNegatives', ws.wsId)) as NegativeOut[]
      const stale = all.filter((n) => n.stale)
      const overturned = all.filter((n) => (n.lastResult ?? 0) > 0)
      return {
        result: {
          count: all.length,
          negatives: all.map((n) => ({
            id: n.id,
            kind: n.kind,
            statement: n.statement,
            whyItMatters: n.whyItMatters,
            scopeSources: n.scope.sourceIds.length,
            hosts: n.scope.hosts ?? [],
            verifiable: n.verifiable,
            stale: n.stale,
            newSourcesSince: n.newSourcesSince,
            stillHolds: (n.lastResult ?? 0) === 0
          })),
          ...(stale.length
            ? { staleNote: `${stale.length} absence(s) were established before evidence that arrived later — their searches never covered it. Re-run them with verify_negative before treating them as fact.` }
            : {}),
          ...(overturned.length
            ? { overturnedNote: `${overturned.length} absence(s) no longer hold — a re-run found rows. Anything concluded from them needs revisiting.` }
            : {})
        },
        card: `list_negatives → ${all.length}${stale.length ? `, ${stale.length} stale` : ''}${overturned.length ? `, ${overturned.length} overturned` : ''}`
      }
    }

    case 'record_entity': {
      if (!ws.hasWorkspace || ws.wsId == null) throw new Error('No workspace is open.')
      const warnings: string[] = []
      const kind = String(args.kind ?? '').trim()
      if (kind !== 'system' && kind !== 'account') throw new Error('record_entity needs kind: "system" or "account".')
      const name = clipField(args.name, 200, 'name', warnings) ?? ''
      if (!name) throw new Error('record_entity needs a name (the host or account as it appears in the data).')
      const rawStatus = args.status == null ? undefined : String(args.status).trim()
      // Declaring something CLEARED is the analyst's determination — the same rule as the Benign tag.
      // Refused loudly rather than downgraded, so the agent never believes a verdict it didn't get.
      if (rawStatus === 'cleared') {
        throw new Error('Only the analyst can mark an entity CLEARED. Use "suspected" or "unknown", or record what you found and leave the verdict to them.')
      }
      if (rawStatus !== undefined && !(AGENT_SETTABLE_STATUSES as readonly string[]).includes(rawStatus)) {
        throw new Error(`Unknown status "${rawStatus}" — use one of: ${AGENT_SETTABLE_STATUSES.join(', ')}.`)
      }
      const role = clipField(args.role, 200, 'role', warnings)
      const notes = clipField(args.notes, 4000, 'notes', warnings)
      const items = Array.isArray(args.grounding) ? (args.grounding as Array<Record<string, unknown>>) : []
      // Grounding is OPTIONAL here, unlike a lead: an uncollected host is precisely the thing that may
      // have no rows of its own yet, and refusing it would lose the collection gap this tool exists for.
      const { grounding, rejected, timeAnomalies } = items.length ? await validateGrounding(ws, items, examined) : { grounding: [], rejected: [], timeAnomalies: [] }
      const id = (await dbw.call('upsertEntity', ws.wsId, { kind, name, status: rawStatus, role, notes }, grounding, 'ai')) as string | null
      if (!id) throw new Error('record_entity could not store that name — it may be blank after trimming.')
      const all = (await dbw.call('listEntities', ws.wsId)) as CsvEntityOut[]
      const me = all.find((e) => e.id === id)
      // Say plainly which of the two axes landed where; "recorded" alone hides whether it's evidenced
      // and whether its data exists, which is the entire content of the record.
      const origin = me?.origin ?? 'asserted'
      const collected = me?.collected ?? false
      // Never re-propose a pair someone has already ruled on — an app that keeps asking a question
      // it has been answered is exactly why the field gets ignored.
      const judged = (await dbw.call('listEntityLinkJudgements', ws.wsId)) as Array<{ entityId: string; other: string }>
      const answered = new Set<string>()
      for (const j of judged) {
        answered.add(`${j.entityId}|${entityId(kind, j.other)}`)
        answered.add(`${entityId(kind, j.other)}|${j.entityId}`)
      }
      const suggestions = all
        .filter((e) => e.id !== id && e.kind === kind && !answered.has(`${id}|${e.id}`))
        .map((e) => aliasSuggestion(kind, name, e.name))
        .filter((s): s is string => Boolean(s))
        .slice(0, 3)
      return {
        result: {
          recorded: true,
          id,
          kind,
          name,
          origin,
          status: me?.status ?? 'unknown',
          collected,
          groundingCount: me?.groundingCount ?? 0,
          ...(warnings.length ? { warnings } : {}),
          ...(rejected.length ? { rejected } : {}),
          ...(timeAnomalies.length ? { timeAnomalies } : {}),
          ...(suggestions.length ? { possibleAliases: suggestions, aliasNote: 'These MAY be the same entity. Nothing was merged. Answer with link_entities (same=true to merge, same=false if genuinely different) — check SIDs or profile directories first; a local and a domain account sharing a name are different principals.' } : {}),
          note:
            origin === 'asserted'
              ? 'Stored as ASSERTED — nothing in the case names it yet, so it shows as unproven (like a lead). It becomes EVIDENCED automatically once the data names it or you cite grounding.'
              : // Collection is a fact about SYSTEMS. An account has no triage package, and telling an
                // agent "nobody pulled its artifacts" about a user account is nonsense that trains it
                // to ignore the field on the systems where it actually matters.
                kind === 'account'
                ? 'Stored as EVIDENCED — the case data names this account.'
                : collected
                  ? 'Stored as EVIDENCED, and this case holds its data.'
                  : 'Stored as EVIDENCED but NOT COLLECTED — the data names it and nobody pulled its artifacts. This is a collection gap; make sure your notes say what you would want from it. If this host IS one already in the case under another name, say so with link_entities.'
        },
        card: `▣ ${kind} "${name}" — ${origin}${kind === 'system' && !collected ? ', not collected' : ''}`
      }
    }

    case 'link_entities': {
      if (!ws.hasWorkspace || ws.wsId == null) throw new Error('No workspace is open.')
      const kind = String(args.kind ?? '').trim()
      if (kind !== 'system' && kind !== 'account') throw new Error('link_entities needs kind: "system" or "account".')
      const primary = String(args.entity ?? '').trim()
      const other = String(args.other ?? '').trim()
      if (!primary || !other) throw new Error('link_entities needs both `entity` and `other`.')
      if (typeof args.same !== 'boolean') {
        throw new Error('link_entities needs `same`: true if they are one entity, false if they are genuinely different. Both answers are recorded.')
      }
      const reason = clipField(args.reason, 1000, 'reason', []) ?? null
      const res = (await dbw.call('linkEntities', ws.wsId, kind, primary, other, args.same, reason, 'ai')) as {
        linked: boolean
        id: string
        merged: boolean
        aliases: string[]
      } | null
      if (!res) throw new Error('link_entities could not record that — check the names are not blank.')
      if (!res.linked) {
        return {
          result: { linked: false, reason: 'Those two names are already the same entity (they differ only by case), so there is nothing to link.' },
          card: `link_entities "${primary}" ≡ "${other}" → already one entity`
        }
      }
      const after = ((await dbw.call('listEntities', ws.wsId)) as CsvEntityOut[]).find((e) => e.id === res.id)
      return {
        result: {
          linked: true,
          id: res.id,
          same: args.same,
          aliases: res.aliases,
          ...(after ? { collected: after.collected, collectedVia: after.collectedVia } : {}),
          note: args.same
            ? `Merged — "${other}" is now an alias of "${primary}" and no longer a separate entity.${after?.collectedVia === 'alias' ? ' This also resolved it to a host whose data the case holds, so it is no longer reported as a collection gap.' : ''}`
            : `Recorded as DIFFERENT entities. That pair will not be suggested again.`
        },
        card: `⇄ ${kind} "${primary}" ${args.same ? '≡' : '≠'} "${other}"`
      }
    }

    case 'list_entities': {
      if (!ws.hasWorkspace || ws.wsId == null) throw new Error('No workspace is open.')
      const all = (await dbw.call('listEntities', ws.wsId)) as CsvEntityOut[]
      const wantKind = args.kind == null ? null : String(args.kind).trim()
      let items = wantKind ? all.filter((e) => e.kind === wantKind) : all
      if (args.uncollected_only === true) items = items.filter((e) => e.kind === 'system' && !e.collected)
      const gaps = all.filter((e) => e.kind === 'system' && !e.collected)
      return {
        result: {
          count: items.length,
          entities: items.map((e) => ({
            id: e.id,
            kind: e.kind,
            name: e.name,
            origin: e.origin,
            status: e.status,
            collected: e.collected,
            // How we know — a short-name match is an inference, not a fact, and says so.
            collectedVia: e.collectedVia,
            eventCount: e.eventCount,
            role: e.role,
            notes: e.notes,
            // Who recorded it — so you can tell your own entries from the analyst's, and don't
            // silently overwrite a judgement a human made.
            addedBy: e.actor,
            aliases: e.aliases
          })),
          // Surfaced even when not asked for: an analyst reading the case needs to know which hosts
          // were never collected, and it is exactly the thing easy to forget to ask about.
          ...(gaps.length ? { collectionGaps: gaps.map((e) => e.name), collectionGapNote: `${gaps.length} system(s) are named in the data but their artifacts were never collected — you cannot pivot into them.` } : {})
        },
        card: `list_entities → ${items.length}${gaps.length ? ` (${gaps.length} uncollected)` : ''}`
      }
    }

    case 'get_investigation_state': {
      if (!ws.hasWorkspace || ws.wsId == null) {
        return { result: { hasWorkspace: false, plan: [], notes: '', recorded: { events: 0, iocs: 0 } }, card: 'get_investigation_state → no workspace open' }
      }
      const inv = (await dbw.call('getInvestigation', ws.wsId)) as { plan?: Array<{ text: string; status: string }>; notes?: string; updatedAt?: number | null }
      const events = (await dbw.call('listEvents', ws.wsId)) as Array<{ createdAt?: number }>
      const iocs = (await dbw.call('listIocs', ws.wsId)) as unknown[]
      const plan = Array.isArray(inv?.plan) ? inv.plan : []
      const startedAt = coverage?.startedAt
      const done = plan.filter((s) => s.status === 'done').length
      return {
        result: {
          plan,
          notes: inv?.notes ?? '',
          recorded: { events: events.length, iocs: iocs.length },
          // RESUMING means work that predates this session, not merely "state exists" — the agent
          // calls update_plan early, which made a case created seconds ago report itself as resumed.
          // Anything recorded before this run started is someone else's (or an earlier session's) work.
          resuming: startedAt != null && ((inv?.updatedAt ?? 0) < startedAt || events.some((e) => (e.createdAt ?? 0) < startedAt))
        },
        card: `get_investigation_state → ${plan.length} plan step(s) (${done} done), ${events.length} event(s), ${iocs.length} IOC(s)`
      }
    }

    case 'review_coverage': {
      if (!ws.hasWorkspace || ws.sources.length === 0) {
        return { result: { hasWorkspace: false, total: 0, examined: [], untouched: [] }, card: 'review_coverage → no workspace open' }
      }
      const { sources: scoped, scopedTo } = scopedSources(ws.sources, args.groups)
      const universe = coverageUniverse(scoped) // exclude the derived Timeline source
      const seen = coverage?.examined ?? new Set<number>()
      const glimpsedIds = coverage?.seenInSearch ?? new Set<number>()
      const examinedSrc = universe.filter((s) => seen.has(s.sourceId))
      // Three states, not two. A source whose rows came back from find_in_all_sources HAS been seen
      // — reporting it as "never touched" sent the agent back to re-read sources it had already
      // built findings from, which is wasted work dressed up as diligence.
      const glimpsedSrc = universe.filter((s) => !seen.has(s.sourceId) && glimpsedIds.has(s.sourceId)).sort((a, b) => b.rowCount - a.rowCount)
      const untouched = universe.filter((s) => !seen.has(s.sourceId) && !glimpsedIds.has(s.sourceId)).sort((a, b) => b.rowCount - a.rowCount)
      const remaining = glimpsedSrc.length + untouched.length
      return {
        result: {
          scope: scopedTo ?? 'all sources',
          total: universe.length,
          examinedCount: examinedSrc.length,
          untouchedCount: untouched.length,
          // Group-qualified paths, not bare names: hosts legitimately share filenames, so listing
          // `hayabusa_events_offline.csv` under both "examined" and "untouched" would read as a
          // contradiction rather than as two different hosts' copies.
          examined: examinedSrc.map((s) => pathOf(s)),
          untouched: untouched.map((s) => ({ source: pathOf(s), rowCount: s.rowCount, group: s.group ?? null })),
          ...(glimpsedSrc.length
            ? {
                seenInSearchOnly: glimpsedSrc.map((s) => ({ source: pathOf(s), rowCount: s.rowCount, group: s.group ?? null })),
                seenInSearchNote:
                  'A cross-source search returned rows from these, so you have seen some of their data — but you have not read them directly. Finish them with a source-targeted call, or say why the search hit is enough.'
              }
            : {}),
          ...(remaining === 0
            ? { complete: true }
            : {
                guidance:
                  'Examine each remaining source (get_distinct / find_rows / get_all_rows / query_workspace) or state why it can be skipped. Triage is not complete until every source is accounted for. Sources are listed biggest-first — a 0-row one is dismissable; a populated one likely holds activity you have not seen.'
              })
        },
        card: `review_coverage → ${examinedSrc.length}/${universe.length} examined${glimpsedSrc.length ? `, ${glimpsedSrc.length} seen-in-search` : ''}${untouched.length ? `, ${untouched.length} untouched` : remaining === 0 ? ' — all covered' : ''}`
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
      // Optional filters restrict which rows are counted (e.g. distinct UserIds WHERE Operation=UserLoggedIn).
      const filters = strictFilters(args.filters, src.columns)
      const res = (await dbw.distinct(src.tabId, reqSeq++, col, filters, limit, () => {})) as {
        rows: Array<{ val: string; cnt: number }>
        total: number
        truncated: boolean
      } | null
      if (!res) return { result: { values: [], total: 0, truncated: false }, card: 'get_distinct → canceled' }
      const label = src.columns.find((c) => c.name === col)?.original ?? col
      const values = res.rows.map((r) => ({ value: clip(r.val), count: r.cnt }))

      // Buckets that are DIFFERENT values but identical once clipped for display. Dedup runs on the
      // full value while the output is truncated, so the list reads as several identical entries —
      // one run saw 19 "distinct" values that looked like 6, each with count 1, and could not tell
      // which was which. Say so rather than letting the display be silently ambiguous.
      const seenClipped = new Map<string, number>()
      for (const v of values) seenClipped.set(v.value, (seenClipped.get(v.value) ?? 0) + 1)
      const ambiguous = [...seenClipped.entries()].filter(([, n]) => n > 1).map(([v]) => v)

      // Hand back the filter set in the exact shape query_workspace/find_rows accept, so drilling into
      // a bucket is a copy rather than a retype. Re-typing them is how a time window got dropped
      // between a distinct call and its follow-up: 55 files in the window became 11,615 overall, and
      // a routine agent-written file was briefly read as mass encryption.
      const drill = filters
        ? {
            appliedFilters: filters,
            drillDown: `To see the rows behind a bucket, pass these SAME filters to query_workspace/find_rows plus {"col":"${col}","op":"eq","value":"<the bucket value>"}. Re-typing the filters instead of reusing them is how a time window gets silently dropped.`
          }
        : {
            drillDown: `To see the rows behind a bucket: query_workspace with {"col":"${col}","op":"eq","value":"<the bucket value>"}.`
          }
      return {
        result: {
          source: pathOf(src),
          column: label,
          columnRef: col,
          ...(filters ? { filtered: true } : {}),
          total: res.total,
          truncated: res.truncated,
          values,
          ...drill,
          ...(ambiguous.length
            ? {
                clippedValues: ambiguous,
                clippedNote: `${ambiguous.length} displayed value(s) appear more than once because they were TRUNCATED for display — the underlying values are distinct and were counted separately. Read the full values with query_sql (SELECT DISTINCT ${col} …) before treating any of them as one.`
              }
            : {})
        },
        card: `get_distinct [${src.name}] ${label}${filters ? ' (filtered)' : ''} → ${res.total} distinct`
      }
    }

    case 'aggregate': {
      const src = resolveSource(ws, args.source)
      examined(src.sourceId)
      const col = resolveCol(args.col, src.columns)
      const by = args.by != null && String(args.by).trim() ? resolveCol(args.by, src.columns) : undefined
      const bucket = typeof args.bucket === 'string' && TIME_BUCKETS.has(args.bucket as TimeBucket) ? (args.bucket as TimeBucket) : undefined
      const filters = strictFilters(args.filters, src.columns)
      const search = typeof args.search === 'string' && args.search.trim() ? args.search.trim() : undefined
      const order: 'count' | 'value' = args.order === 'value' ? 'value' : 'count'
      const limit = Math.min(Math.max(Number(args.limit) || 50, 1), AGG_CAP)
      const res = (await dbw.call('aggregate', src.tabId, { col, by, bucket, filters, search, limit, order })) as {
        groups: Array<{ value: string; by?: string; count: number }>
        returned: number
        totalBuckets: number
        truncated: boolean
      }
      const colLabel = src.columns.find((c) => c.name === col)?.original ?? col
      const byLabel = by ? (src.columns.find((c) => c.name === by)?.original ?? by) : undefined
      return {
        result: {
          source: pathOf(src),
          groupBy: colLabel,
          ...(byLabel ? { pivotBy: byLabel } : {}),
          ...(bucket ? { bucket } : {}),
          ...(filters || search ? { filtered: true } : {}),
          buckets: res.returned,
          totalBuckets: res.totalBuckets,
          truncated: res.truncated,
          ...(res.truncated ? { note: `Showing the top ${res.returned} of ${res.totalBuckets} buckets — raise \`limit\` to see more.` } : {}),
          groups: res.groups
        },
        card: `aggregate [${src.name}] ${colLabel}${byLabel ? ` × ${byLabel}` : ''}${bucket ? ` (${bucket})` : ''} → ${res.returned}${res.truncated ? ` of ${res.totalBuckets}` : ''} bucket(s)`
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

    case 'query_sql': {
      if (!ws.hasWorkspace || !ws.wsId) throw new Error('No case is open. Use use_workspace or create_case first.')
      const sql = String(args.sql ?? '').trim()
      const wsId = ws.wsId
      // Audit first, outcome second: every attempt is recorded, and a REFUSED one is the most
      // interesting entry in the log because it shows what the agent tried to do.
      const audit = (e: { outcome: 'ok' | 'refused' | 'error'; rowCount?: number; elapsedMs?: number; detail?: string | null }): void => {
        void dbw.call('logAgentSql', wsId, { sql, ...e })
      }

      const verdict = checkAgentSql(sql)
      if (!verdict.ok) {
        audit({ outcome: 'refused', detail: verdict.reason })
        throw new Error(`That SQL was refused: ${verdict.reason}`)
      }

      const dbPath = await dbw.call<string | null>('openWorkspacePath', wsId)
      if (!dbPath) throw new Error('The open case has no database on disk yet.')
      const rowCap = Math.min(Math.max(Number(args.limit) || SQL_ROW_CAP, 1), SQL_ROW_CAP)

      let res
      try {
        res = await runAgentSql(dbPath, sql, { rowCap, cellCap: CELL_CAP, deadlineMs: SQL_DEADLINE_MS, killMs: SQL_KILL_MS })
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        audit({ outcome: 'error', detail: message })
        throw e
      }
      audit({ outcome: 'ok', rowCount: res.rows.length, elapsedMs: res.elapsedMs, detail: res.truncated ?? null })

      // Rows arrive as arrays so duplicate column names across a UNION/JOIN survive; turn them into
      // objects for the model, keeping the positional name even where it repeats.
      const rows = res.rows.map((r) => Object.fromEntries(r.map((v, i) => [res.columns[i] ?? `col${i}`, v])))
      return {
        result: {
          columns: res.columns,
          rowCount: rows.length,
          rows,
          ...(res.truncated ? { truncated: res.truncated } : {}),
          elapsedMs: res.elapsedMs
        },
        card: `query_sql → ${rows.length} row(s)${res.truncated ? ' (capped)' : ''} in ${res.elapsedMs}ms`
      }
    }

    case 'classify_indicator': {
      const value = String(args.value ?? '')
      return { result: { value, kind: classifyIndicator(value) }, card: `classify_indicator "${value}"` }
    }

    // ---- Case lifecycle: the agent builds its own case, the analyst watches it fill ----

    case 'list_workspaces': {
      const entries = await dbw.call<WorkspaceEntry[]>('listWorkspaces')
      const workspaces = entries.map((e) => ({
        name: e.name,
        sources: e.sourceCount,
        created: e.createdAt ? new Date(e.createdAt).toISOString() : null
      }))
      return { result: { workspaces }, card: `list_workspaces → ${workspaces.length} case(s)` }
    }

    case 'create_case': {
      const name = String(args.name ?? '').trim().slice(0, 200)
      if (!name) throw new Error('A case name is required.')
      const showWorkspace = deps?.showWorkspace
      if (!showWorkspace) throw new Error('This build cannot open a case from the agent side.')
      // Refuse an exact-name duplicate. CLAUDE.md tells the agent a duplicate case splits one
      // investigation across two files, and it does check list_workspaces first — but nothing
      // enforced it, so a retry or a second session would happily create a seventh case of the same
      // name, and the analyst is the one left reconciling them. Refuse rather than warn: the
      // recovery ("resume it, or pick a distinct name") is unambiguous and cheap.
      const existing = await dbw.call<WorkspaceEntry[]>('listWorkspaces')
      const clash = existing.find((e) => e.name.trim().toLowerCase() === name.toLowerCase())
      if (clash) {
        throw new Error(
          `A case named "${clash.name}" already exists (${clash.sourceCount} source(s)). Resume it with use_workspace("${clash.name}") — or, if this really is separate work, create_case with a distinct name.`
        )
      }
      // A stable-but-unique id; the human name lives in ws_meta, the filename is this id.
      const wsId = randomUUID()
      const info = await dbw.call<{ wsId: string; dbPath: string; name: string }>('createWorkspace', wsId, name)
      // Wait for the app to actually have it open before returning — otherwise the agent's next call
      // would still be pointed at the previous case. See ToolDeps.showWorkspace.
      const opened = await showWorkspace({ wsId: info.wsId, dbPath: info.dbPath, name: info.name })
      return {
        result: {
          created: info.name,
          workspace: opened.workspaceName ?? info.name,
          sources: 0,
          next: 'Call list_evidence to see what the analyst has made available, then import_evidence.'
        },
        card: `created case "${info.name}"`
      }
    }

    case 'use_workspace': {
      const ref = String(args.workspace ?? '').trim()
      if (!ref) throw new Error('A case name is required — call list_workspaces to see them.')
      const showWorkspace = deps?.showWorkspace
      if (!showWorkspace) throw new Error('This build cannot open a case from the agent side.')
      const entries = await dbw.call<WorkspaceEntry[]>('listWorkspaces')
      if (entries.length === 0) throw new Error('There are no cases yet. Use create_case to start one.')
      const lower = ref.toLowerCase()
      // Exact name, then id, then a UNIQUE substring — ambiguity is an error, never a silent pick:
      // opening the wrong case would send every subsequent write to the wrong investigation.
      let matches = entries.filter((e) => e.name.toLowerCase() === lower || e.wsId === ref)
      if (matches.length === 0) matches = entries.filter((e) => e.name.toLowerCase().includes(lower))
      if (matches.length === 0) {
        throw new Error(`No case matches "${ref}". Available: ${entries.map((e) => `"${e.name}"`).join(', ')}`)
      }
      if (matches.length > 1) {
        throw new Error(`"${ref}" is ambiguous — it matches ${matches.map((e) => `"${e.name}"`).join(', ')}. Use the full name.`)
      }
      const target = matches[0]
      const opened = await showWorkspace({ wsId: target.wsId, dbPath: target.dbPath, name: target.name })
      const sources = opened.sources.map((s) => ({ id: s.sourceId, name: s.name, group: s.group ?? null, rowCount: s.rowCount }))
      return {
        result: {
          workspace: opened.workspaceName ?? target.name,
          sources,
          next: 'Call get_investigation_state to recover the plan and everything already recorded before doing new work.'
        },
        card: `opened case "${target.name}" — ${sources.length} source(s)`
      }
    }

    case 'list_evidence': {
      const subdir = typeof args.subdir === 'string' && args.subdir.trim() ? args.subdir.trim() : undefined
      const { files, truncated } = await dbw.call<WalkResult>('listEvidence', subdir)
      const importable = files.filter((f) => f.importable)
      const skippedCount = files.length - importable.length
      const groups = [...new Set(importable.map((f) => f.group).filter((g): g is string => !!g))].sort()
      return {
        result: {
          files: importable.map((f) => ({ path: f.path, group: f.group, bytes: f.bytes })),
          groups,
          // Non-importable content is SUMMARIZED, not listed: one host's RDP bitmap cache is
          // thousands of .bmp files, and returning every path would bury the 30-odd artifacts that
          // actually matter. The counts still tell the agent what the package holds, so it can say
          // "there is an RDP bitmap cache I can't ingest" instead of assuming it isn't there.
          ...(skippedCount ? { notImportable: { count: skippedCount, byType: summarizeNotImportable(files) } } : {}),
          ...(truncated ? { truncated: 'This listing is PARTIAL — the evidence folder holds more files than can be listed at once. Narrow it with `subdir`.' } : {})
        },
        card: `list_evidence → ${importable.length} importable file(s)${groups.length ? `, ${groups.length} host(s)` : ''}`
      }
    }

    case 'import_evidence': {
      if (!ws.hasWorkspace || !ws.wsId) {
        throw new Error('No case is open. Call create_case to start one (or use_workspace to resume an existing case) before importing evidence.')
      }
      const override = typeof args.group === 'string' && args.group.trim() ? args.group.trim() : null

      // Which directory level names the host, derived from the WHOLE evidence tree — the same level
      // list_evidence reported. Computing it from just `paths` would be wrong: a single-host batch
      // doesn't branch, so the inference would descend into artifact-category directories.
      const groupDepth = override ? 0 : await dbw.call<number>('evidenceGroupDepth')

      // The whole tree, so `hosts` can be expanded and a partial import can report what it left.
      const tree = (await dbw.call<WalkResult>('listEvidence')).files.filter((f) => f.importable)

      const wantHosts = (Array.isArray(args.hosts) ? args.hosts : []).map((h) => String(h ?? '').trim()).filter(Boolean)
      const rawPaths = (Array.isArray(args.paths) ? args.paths : []).map((p) => String(p ?? '').trim()).filter(Boolean)
      if (wantHosts.length === 0 && rawPaths.length === 0) {
        throw new Error('Pass `hosts` (imports every artifact for those hosts — the normal choice) or `paths` (specific files from list_evidence).')
      }

      // hosts → every importable file under those host folders. Deciding relevance BEFORE reading the
      // data is how artifacts get wrongly dropped: a triage package's value is only knowable after you
      // look at it, so host import takes that judgement off the table.
      const known = [...new Set(tree.map((f) => f.group).filter((g): g is string => !!g))]
      const unknownHosts = wantHosts.filter((h) => !known.some((k) => k.toLowerCase() === h.toLowerCase()))
      if (unknownHosts.length > 0) {
        throw new Error(`No evidence for host(s): ${unknownHosts.join(', ')}. Available: ${known.join(', ') || '(none — evidence is ungrouped)'}.`)
      }
      const fromHosts = tree
        .filter((f) => f.group && wantHosts.some((h) => h.toLowerCase() === f.group!.toLowerCase()))
        .map((f) => f.path)
      const paths = [...new Set([...fromHosts, ...rawPaths])]

      const imported: Array<{ path: string; source: string; group: string | null; rowCount: number }> = []
      const failed: Array<{ path: string; error: string }> = []
      const importedIds: number[] = []
      for (const rel of paths) {
        try {
          // Refuse anything the ingest engine doesn't handle BEFORE opening it. Feeding a SQLite db
          // or a bitmap to the CSV parser "succeeds" — it yields thousands of garbage rows that the
          // agent would then reason over and cite as evidence. Refusing with a reason is the only
          // honest answer, and it names what would make the artifact importable.
          const kind = classifyEvidence(baseName(rel))
          if (kind === 'unsupported') {
            failed.push({ path: rel, error: unsupportedReason(baseName(rel)) })
            continue
          }
          // Containment is proved in the worker, against the analyst-set root — an escaping path
          // throws here and is reported per-file, never silently skipped.
          const abs = await dbw.call<string>('resolveInsideEvidenceRoot', rel)
          // Same LEVEL list_evidence used, so the group the agent saw is the group it gets.
          const derived = groupAtDepth(rel, groupDepth)
          const group = override ?? derived
          const common = { wsId: ws.wsId, filePath: abs, sourceName: baseName(rel), group }
          type Landed = { sourceId: number; name: string; rowCount: number; group: string | null }
          // A workbook becomes one source PER WORKSHEET, so it goes to the Excel ingester and can
          // land several sources from a single path.
          const landed: Landed[] =
            kind === 'excel'
              ? await dbw.ingest<Landed[]>('addXlsxSources', common, ws.wsId, () => {})
              : [await dbw.ingest<Landed>('addSource', common, ws.wsId, () => {})]
          for (const info of landed) {
            imported.push({ path: rel, source: info.name, group: info.group ?? null, rowCount: info.rowCount })
            importedIds.push(info.sourceId)
          }
        } catch (e) {
          failed.push({ path: rel, error: e instanceof Error ? e.message : String(e) })
        }
      }
      if (imported.length === 0) {
        throw new Error(`No evidence could be imported. ${failed.map((f) => `${f.path}: ${f.error}`).join('; ')}`)
      }
      // Don't return until the app has caught up: the tools read the RENDERER's source list, so
      // returning early would make the very next list_sources report an empty case. A timeout here
      // is reported, not swallowed — the data IS imported, only the view is behind.
      let syncWarning: string | null = null
      let syncedSources: WsSource[] | null = null
      if (deps?.syncSources) {
        try {
          const synced = await deps.syncSources(ws.wsId, importedIds)
          syncedSources = synced.sources
          // Report FINAL labels. Importing a colliding artifact re-labels the source already in the
          // case (see planSourceNaming), so the name captured mid-loop can be out of date by the end
          // — and naming a source that no longer exists is worse than not naming it at all.
          const finalName = new Map(synced.sources.map((s) => [s.sourceId, s.name]))
          imported.forEach((rec, i) => {
            const name = finalName.get(importedIds[i])
            if (name) rec.source = name
          })
        } catch (e) {
          syncWarning = e instanceof Error ? e.message : String(e)
        }
      }
      // What was LEFT BEHIND in any host folder this call touched. Choosing a subset of a host's
      // artifacts on a relevance guess is how a needed one gets dropped — the last run skipped $J/
      // USNJRNL as "redundant with $MFT" and then lost the only place deleted-file residue survives.
      // The omission used to be invisible: nothing said "12 of 19". Now it is named, per host.
      const importedNames = new Set(
        (syncedSources ?? []).map((s) => `${(s.group ?? '').toLowerCase()} ${s.name.toLowerCase()}`)
      )
      const touchedHosts = [...new Set(paths.map((p) => groupAtDepth(p, groupDepth)).filter((g): g is string => !!g))]
      const notImported = touchedHosts
        .map((host) => {
          const remaining = tree
            .filter((f) => f.group === host && !paths.includes(f.path))
            .filter((f) => !importedNames.has(`${host.toLowerCase()} ${f.name.toLowerCase()}`))
            .map((f) => f.path)
          return { host, remaining }
        })
        .filter((h) => h.remaining.length > 0)

      return {
        result: {
          imported,
          ...(failed.length ? { failed } : {}),
          ...(syncWarning ? { warning: syncWarning } : {}),
          ...(notImported.length
            ? {
                notImported,
                notImportedNote:
                  'These artifacts belong to hosts you just imported but were NOT taken. You cannot know which artifact answers the question before you read it — a "redundant" journal is exactly where deleted-file residue survives. Import them with hosts: [...] unless you can say specifically why each is not needed, and state that reasoning in your report.'
              }
            : {}),
          next: 'Call list_sources to see the case as it now stands, then describe_workspace before querying.'
        },
        card: `imported ${imported.length} file(s)${failed.length ? `, ${failed.length} failed` : ''}`
      }
    }

    default:
      if (!KNOWN_TOOLS.has(name)) throw new Error(`Unknown tool: ${name}`)
      throw new Error(`Tool not implemented: ${name}`)
    }
  })()
  if (outcome.result && typeof outcome.result === 'object' && !Array.isArray(outcome.result)) {
    const r = outcome.result as Record<string, unknown>
    if (!('workspace' in r)) r.workspace = ws.hasWorkspace ? ws.workspaceName ?? 'workspace' : 'none'
  }
  return outcome
}
