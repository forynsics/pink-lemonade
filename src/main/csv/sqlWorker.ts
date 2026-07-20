// Runs ONE agent-supplied read-only SELECT, on its own thread, then exits.
//
// Why a dedicated worker rather than the shared DB worker: better-sqlite3 11.x exposes no
// `interrupt()` and no progress handler, so a running query CANNOT be cancelled on its connection.
// The DB worker owns every connection the app uses, so a pathological query there — a cartesian join
// across two large artifacts — would freeze the analyst's own grid alongside the agent's request.
// Here the only thing a runaway starves is itself, and the parent kills the thread.
//
// Note honestly what terminate() can and cannot do: it stops the thread between JS turns, so it
// reliably ends a query that is PRODUCING ROWS (a recursive CTE, a huge join). It cannot interrupt a
// single blocking native call — SQLite materializes an ORDER BY or GROUP BY before yielding the first
// row, and that runs to completion inside C++. Thread isolation, not cancellation, is what actually
// protects the UI; the deadline and the caps bound everything else.

import Database from 'better-sqlite3'
import { parentPort, workerData } from 'node:worker_threads'

const port = parentPort
if (!port) throw new Error('sqlWorker.ts must run as a worker thread')

interface Job {
  dbPath: string
  sql: string
  rowCap: number
  cellCap: number
  deadlineMs: number
}

const job = workerData as Job

/** Cell values are stringified and clipped — one BLOB or a 40 KB event payload would otherwise blow
 *  the caller's context, and this tool exists to answer questions, not to export data. */
function cell(v: unknown, cap: number): string {
  if (v == null) return ''
  if (v instanceof Uint8Array) return `<${v.byteLength} bytes>`
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
  return s.length > cap ? s.slice(0, cap - 1) + '…' : s
}

try {
  // readonly + fileMustExist: the second layer after the statement guard. Even a statement that
  // slipped through cannot write, and this can never create a database as a side effect.
  const db = new Database(job.dbPath, { readonly: true, fileMustExist: true })
  const stmt = db.prepare(job.sql)
  // .raw() gives arrays rather than objects, so duplicate column names across a UNION/JOIN survive
  // instead of silently collapsing into one key.
  const iter = (stmt as unknown as { raw: (v: boolean) => { iterate: () => IterableIterator<unknown[]>; columns: () => Array<{ name: string }> } }).raw(true)
  const columns = iter.columns().map((c) => c.name)

  const rows: string[][] = []
  const started = Date.now()
  let truncated: string | undefined
  // Pull row by row so the deadline is checked between rows — this is what catches a query that
  // returns forever. .all() would hand back control only once everything had been materialized.
  for (const r of iter.iterate()) {
    if (rows.length >= job.rowCap) {
      truncated = `Stopped at the ${job.rowCap}-row cap — there are more rows. Narrow the query, or aggregate (COUNT/GROUP BY) instead of listing.`
      break
    }
    if (Date.now() - started > job.deadlineMs) {
      truncated = `Stopped after ${Math.round(job.deadlineMs / 1000)}s — the query was still producing rows. Narrow it, or aggregate instead of listing.`
      break
    }
    rows.push(r.map((v) => cell(v, job.cellCap)))
  }
  db.close()
  port.postMessage({ ok: true, columns, rows, truncated, elapsedMs: Date.now() - started })
} catch (e) {
  port.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) })
}
