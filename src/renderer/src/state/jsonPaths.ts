// Pure helper for the "Extract JSON field" workflow — no React/IPC, fully unit-testable.
//
// Logs like the O365 Unified Audit Log cram most of their content into ONE JSON column
// (`AuditData` — Operation, ClientIPAddress, UserId, nested Folders[]/OperationProperties[], …).
// `discoverScalarPaths` samples a column's values and reports its top-level JSON keys so the UI can
// offer to pull the scalar ones into first-class grid columns. v1 is top-level only: nested
// arrays/objects are reported (greyed) but stay as JSON text — extracting a scalar leaf preserves
// row cardinality (and therefore the rowid linkage that tags/marks/events depend on).

export type JsonFieldKind = 'scalar' | 'array' | 'object'

export interface JsonField {
  /** JSON1 path to extract, e.g. `$.Operation` (bound as a parameter to json_extract — never interpolated). */
  path: string
  /** The top-level key (the default display name for the extracted column). */
  key: string
  /** scalar = a leaf (string/number/bool/null) we can pull into a column; array/object stay as JSON text. */
  kind: JsonFieldKind
  /** First-seen example value (scalar: the value as text; array/object: a short shape hint). */
  example: string
}

const MAX_EXAMPLE = 80

/**
 * Union the top-level keys across a sample of a column's values (each a JSON object, typically), in
 * first-seen order, with a first-seen example. Non-object / unparseable samples are skipped. Callers
 * filter `kind === 'scalar'` for the extractable set; arrays/objects are surfaced so the UI can show
 * (and explain) why they aren't offered.
 */
export function discoverScalarPaths(samples: string[]): JsonField[] {
  const byKey = new Map<string, JsonField>()
  for (const raw of samples) {
    if (typeof raw !== 'string') continue
    const s = raw.trim()
    if (s === '' || s[0] !== '{') continue // only a top-level JSON object yields keys
    let parsed: unknown
    try {
      parsed = JSON.parse(s)
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
      const existing = byKey.get(key)
      if (existing && existing.kind === 'scalar' && existing.example !== 'null') continue
      // First-seen wins, but a later non-null scalar upgrades an earlier null example (sparse fields).
      byKey.set(key, { path: jsonPath(key), key, kind: kindOf(val), example: exampleOf(val) })
    }
  }
  return [...byKey.values()]
}

function kindOf(v: unknown): JsonFieldKind {
  if (Array.isArray(v)) return 'array'
  if (v !== null && typeof v === 'object') return 'object'
  return 'scalar' // string | number | boolean | null
}

function exampleOf(v: unknown): string {
  if (Array.isArray(v)) return `[${v.length}]`
  if (v !== null && typeof v === 'object') return '{…}'
  if (v === null) return 'null'
  return cap(String(v))
}

/** Simple identifier keys use dot syntax; anything else is quoted so json_extract still resolves it. */
function jsonPath(key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `$.${key}` : `$.${JSON.stringify(key)}`
}

function cap(s: string): string {
  return s.length > MAX_EXAMPLE ? `${s.slice(0, MAX_EXAMPLE - 1)}…` : s
}
