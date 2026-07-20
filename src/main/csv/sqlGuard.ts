// Validation for agent-supplied SQL. Pure and dependency-free so the security boundary is unit
// testable — this is the gate, not a convenience check.
//
// Defence in depth, three layers, and this is only the first:
//   1. THIS: reject anything that isn't a single read-only SELECT/WITH.
//   2. The connection is opened `readonly: true`, so no statement can write whatever it says.
//   3. Execution happens on its own worker thread, so a pathological query starves only itself.
//
// The layer that matters most here is ATTACH. A read-only connection still permits ATTACH, which
// would let a query reach ANY other SQLite file on disk — other cases, the enrichment cache, or an
// evidence-root database the agent is otherwise forbidden to open. Read-only does not contain that;
// only refusing the keyword does.

export interface SqlVerdict {
  ok: boolean
  /** Why it was refused, phrased so the caller can fix it rather than guess. */
  reason?: string
}

// Statements that must never run, even though most are already impossible on a readonly connection.
// Belt and braces: if the connection were ever opened writable by mistake, this still holds.
const FORBIDDEN = [
  ['attach', 'ATTACH would open another database file — including other cases and the evidence root.'],
  ['detach', 'DETACH only makes sense alongside ATTACH, which is not permitted.'],
  ['pragma', 'PRAGMA can change connection behaviour and expose engine internals.'],
  ['vacuum', 'VACUUM rewrites the database.'],
  ['insert', 'this connection is read-only.'],
  ['update', 'this connection is read-only.'],
  ['delete', 'this connection is read-only.'],
  ['replace', 'this connection is read-only.'],
  ['drop', 'this connection is read-only.'],
  ['alter', 'this connection is read-only.'],
  ['create', 'this connection is read-only.'],
  ['reindex', 'this connection is read-only.'],
  ['trigger', 'triggers can execute writes.'],
  ['savepoint', 'transaction control is not permitted.'],
  ['begin', 'transaction control is not permitted.'],
  ['commit', 'transaction control is not permitted.'],
  ['rollback', 'transaction control is not permitted.']
] as const

/**
 * Strip comments and string/identifier literals, so keyword checks can't be fooled by a value that
 * merely CONTAINS a keyword — `WHERE path LIKE '%attach%'` is a legitimate query, and a naive
 * `includes('attach')` would refuse it. What remains is SQL structure only.
 *
 * Exported for the tests: getting this wrong is how a guard becomes theatre.
 */
export function stripLiterals(sql: string): string {
  let out = ''
  let i = 0
  while (i < sql.length) {
    const c = sql[i]
    const next = sql[i + 1]
    if (c === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i++
      continue
    }
    if (c === '/' && next === '*') {
      i += 2
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++
      i += 2
      continue
    }
    // '…' string, "…" / […] / `…` quoted identifier. SQLite escapes a quote by doubling it, which
    // this handles naturally: the closing quote ends the literal and the next one re-opens it.
    if (c === "'" || c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c
      i++
      while (i < sql.length && sql[i] !== close) i++
      i++
      out += ' ' // collapse the literal to a separator so tokens either side stay distinct
      continue
    }
    out += c
    i++
  }
  return out
}

/** Statement count, ignoring a single trailing semicolon. */
function statementCount(stripped: string): number {
  return stripped
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean).length
}

/**
 * Is this a single, read-only SELECT the agent may run?
 *
 * Deliberately strict: an unclear query is refused with a reason rather than run in the hope it is
 * harmless. The agent has curated tools for everything routine, so a false refusal costs it one
 * rephrase, whereas a false accept touches the analyst's evidence.
 */
export function checkAgentSql(sql: unknown): SqlVerdict {
  const raw = String(sql ?? '').trim()
  if (!raw) return { ok: false, reason: 'No SQL was supplied.' }

  const stripped = stripLiterals(raw)
  const n = statementCount(stripped)
  if (n === 0) return { ok: false, reason: 'No SQL statement was found (comments only?).' }
  if (n > 1) {
    return { ok: false, reason: `Only ONE statement may be run; this contains ${n}. Send a single SELECT.` }
  }

  const words = stripped.toLowerCase().match(/[a-z_]+/g) ?? []

  // Forbidden keywords are checked BEFORE the "must start with SELECT" rule, so `ATTACH …` is told
  // what is actually wrong with it rather than the generic "that isn't a SELECT" — the specific
  // reason is the one that tells the caller not to look for a way around it.
  const wordSet = new Set(words)
  for (const [kw, why] of FORBIDDEN) {
    if (wordSet.has(kw)) return { ok: false, reason: `"${kw.toUpperCase()}" is not permitted — ${why}` }
  }

  // PRAGMA also has a table-valued FUNCTION form — `SELECT * FROM pragma_table_info('data_0')`,
  // pragma_database_list, pragma_function_list, … — which the tokenizer keeps as a single
  // `pragma_x` word, so the `pragma` entry above (an exact-word match) never sees it. This family
  // exists only to reflect engine internals, exactly what the PRAGMA rule forbids; refuse it too.
  // (No legitimate query needs it: agent SQL runs against data_<n> tables whose columns are c0..cN.)
  if (words.some((w) => w.startsWith('pragma_'))) {
    return { ok: false, reason: 'PRAGMA table-valued functions (pragma_table_info, …) are not permitted — they expose engine internals.' }
  }

  const first = words[0]
  if (first !== 'select' && first !== 'with') {
    return { ok: false, reason: `Only SELECT (or WITH … SELECT) is allowed; this starts with "${first ?? '?'}".` }
  }
  return { ok: true }
}
