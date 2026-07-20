// Spawns the one-shot SQL worker and enforces the wall-clock limit the worker itself cannot.
//
// A fresh worker per query, deliberately: there is no state worth reusing, a killed thread leaves
// nothing to clean up, and ~20 ms of startup is nothing against a forensic query. The alternative —
// a persistent worker that must be terminated and respawned on timeout — buys nothing and adds a
// lifecycle to get wrong.

import { Worker } from 'node:worker_threads'
import { join } from 'node:path'

export interface SqlResult {
  columns: string[]
  rows: string[][]
  /** Set when the row cap or the deadline stopped the read early — the answer is PARTIAL. */
  truncated?: string
  elapsedMs: number
}

export interface SqlLimits {
  rowCap: number
  cellCap: number
  /** Budget for producing rows, enforced inside the worker between rows. */
  deadlineMs: number
  /** Hard wall-clock kill from out here, covering the case the in-worker deadline cannot see. */
  killMs: number
}

/** Built alongside the DB worker (see electron.vite.config.ts). */
function workerPath(): string {
  return join(__dirname, 'sqlWorker.js')
}

/**
 * Run one validated read-only SELECT against a workspace file.
 *
 * The kill timer exists because the in-worker deadline only fires BETWEEN rows: SQLite materializes
 * an ORDER BY or GROUP BY before yielding row one, and that is a single blocking native call the
 * worker cannot interrupt. Terminating the thread is best-effort against that case — what genuinely
 * protects the app is that the blocked thread is not the one serving the analyst's grid.
 */
export function runAgentSql(dbPath: string, sql: string, limits: SqlLimits): Promise<SqlResult> {
  return new Promise<SqlResult>((resolve, reject) => {
    const worker = new Worker(workerPath(), {
      workerData: { dbPath, sql, rowCap: limits.rowCap, cellCap: limits.cellCap, deadlineMs: limits.deadlineMs }
    })
    let settled = false
    const done = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(kill)
      void worker.terminate()
      fn()
    }
    const kill = setTimeout(() => {
      done(() =>
        reject(
          new Error(
            `The query did not finish within ${Math.round(limits.killMs / 1000)}s and was stopped. A sort or grouping over a large artifact cannot be interrupted once started — add a WHERE clause to cut the rows first, or aggregate instead of ordering.`
          )
        )
      )
    }, limits.killMs)

    worker.on('message', (m: { ok: boolean; error?: string } & SqlResult) => {
      done(() => (m.ok ? resolve({ columns: m.columns, rows: m.rows, truncated: m.truncated, elapsedMs: m.elapsedMs }) : reject(new Error(m.error ?? 'query failed'))))
    })
    worker.on('error', (e) => done(() => reject(e)))
    worker.on('exit', (code) => {
      // Only meaningful if it exited without ever answering.
      done(() => reject(new Error(`The SQL worker exited unexpectedly (code ${code}).`)))
    })
  })
}
