// Main-process proxy for the DB worker. Every query/ingest/tag/enrich op is forwarded to worker.ts
// and awaited; progress (ingest bytes/rows, count + distinct partials, enrich per-indicator) streams
// back through per-request callbacks. The renderer's csv:*/enrich:* IPC already returns Promises, so
// making these async is transparent to it.

import { Worker } from 'node:worker_threads'
import { app } from 'electron'
import { join } from 'path'

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  onProgress?: (p: unknown) => void
}

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, Pending>()

export function initDbWorker(): void {
  if (worker) return
  // Built alongside the main entry → out/main/worker.js (see electron.vite.config.ts).
  worker = new Worker(join(__dirname, 'worker.js'), {
    workerData: { userDataDir: app.getPath('userData') }
  })
  worker.on('message', (msg: { t: string; id: number; ok?: boolean; value?: unknown; error?: string; payload?: unknown }) => {
    const p = pending.get(msg.id)
    if (!p) return
    if (msg.t === 'progress') {
      p.onProgress?.(msg.payload)
    } else if (msg.t === 'result') {
      pending.delete(msg.id)
      if (msg.ok) p.resolve(msg.value)
      else p.reject(new Error(msg.error ?? 'db worker error'))
    }
  })
  const teardown = (e: Error): void => {
    // A worker-level crash/exit fails every in-flight request rather than hanging them — AND clears the
    // dead handle, so the next call re-inits a fresh worker instead of posting into a corpse and never
    // resolving (which is exactly what happened while `worker` stayed set to the dead one).
    for (const [, p] of pending) p.reject(e)
    pending.clear()
    worker = null
  }
  worker.on('error', teardown)
  worker.on('exit', (code) => {
    if (code !== 0) teardown(new Error(`DB worker exited with code ${code}`))
  })
}

function w(): Worker {
  // Re-init if the worker crashed and was torn down, so a post-crash call spawns a fresh worker
  // instead of throwing. (The in-flight calls that were live at crash time already rejected.)
  if (!worker) initDbWorker()
  if (!worker) throw new Error('DB worker not started (initDbWorker)')
  return worker
}

/** Call a plain (serializable) db function in the worker. */
export function call<T = unknown>(fn: string, ...args: unknown[]): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    w().postMessage({ t: 'call', id, fn, args })
  })
}

/** Run an ingest (ingestCsv | addSource | addXlsxSources); `onProgress` fires for each progress tick. */
export function ingest<T = unknown>(
  fn: 'ingestCsv' | 'addSource' | 'addXlsxSources',
  args: Record<string, unknown>,
  cancelKey: string,
  onProgress: (p: { bytes: number; rows: number; total: number }) => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = nextId++
    pending.set(id, {
      resolve: resolve as (v: unknown) => void,
      reject,
      onProgress: (p) => onProgress(p as { bytes: number; rows: number; total: number })
    })
    w().postMessage({ t: 'ingest', id, fn, cancelKey, args })
  })
}

/** Abort an in-flight ingest by its cancel key (tabId for a single import, wsId for a source). */
export function cancel(cancelKey: string): void {
  worker?.postMessage({ t: 'cancel', cancelKey })
}

/** Build the materialized filter index for a predicate; streams partial counts via `onPartial`. */
export function count(
  tabId: string,
  reqId: number,
  filters: unknown,
  search: string | undefined,
  onPartial: (p: { count: number; scanned: number; max: number }) => void
): Promise<number | null> {
  return new Promise<number | null>((resolve, reject) => {
    const id = nextId++
    pending.set(id, {
      resolve: resolve as (v: unknown) => void,
      reject,
      onProgress: (p) => onPartial(p as { count: number; scanned: number; max: number })
    })
    w().postMessage({ t: 'count', id, tabId, reqId, filters, search })
  })
}

interface DistinctResult {
  rows: Array<{ val: string; cnt: number }>
  total: number
  truncated: boolean
}

/** Chunked distinct: streams partial counts via `onPartial`; resolves with the result or null (canceled). */
export function distinct(
  tabId: string,
  reqId: number,
  col: string,
  filters: unknown,
  limit: number,
  onPartial: (p: { count: number; scanned: number; max: number }) => void
): Promise<DistinctResult | null> {
  return new Promise<DistinctResult | null>((resolve, reject) => {
    const id = nextId++
    pending.set(id, {
      resolve: resolve as (v: unknown) => void,
      reject,
      onProgress: (p) => onPartial(p as { count: number; scanned: number; max: number })
    })
    w().postMessage({ t: 'distinct', id, tabId, reqId, col, filters, limit })
  })
}

/** Abort an in-flight distinct scan for a tab (panel closed / column changed). */
export function distinctCancel(tabId: string): void {
  worker?.postMessage({ t: 'distinctCancel', tabId })
}

interface EnrichBulkResult {
  rows: Array<{
    indicator: string
    kind: string
    status: 'ok' | 'notfound' | 'error' | 'skipped' | 'private'
    fields: Record<string, string>
    fromCache: boolean
    fetchedAt?: number
    message?: string
  }>
  canceled?: boolean
  /** Set when the run stopped early for a non-cancel reason (e.g. VirusTotal daily quota exhausted). */
  aborted?: 'quota'
  message?: string
  stats?: {
    cacheHits: number
    cacheMisses: number
    networkLookups: number
    rateLimitSleeps: number
    retryCount: number
    count429: number
    avgLatencyMs: number
  }
}

/** Bulk-enrich indicators against a provider, writing results to the intel DB at `dbPath`; streams
 *  per-indicator progress via `onPartial`. `secrets` (decrypted in main — the worker can't) carries
 *  the per-run API key and detected pace for network providers like VirusTotal. */
export function enrichBulk(
  reqId: number,
  dbPath: string,
  providerId: string,
  items: Array<{ value: string; kind: string }>,
  now: number,
  onPartial: (p: { done: number; total: number; current: string; fromCache: boolean }) => void,
  secrets?: { apiKey?: string; requestsPerMinute?: number }
): Promise<EnrichBulkResult> {
  return new Promise<EnrichBulkResult>((resolve, reject) => {
    const id = nextId++
    pending.set(id, {
      resolve: resolve as (v: unknown) => void,
      reject,
      onProgress: (p) => onPartial(p as { done: number; total: number; current: string; fromCache: boolean })
    })
    w().postMessage({ t: 'enrich', id, reqId, dbPath, providerId, items, now, secrets })
  })
}

/** Abort the in-flight bulk enrichment (a newer run or a user cancel). */
export function enrichCancel(): void {
  worker?.postMessage({ t: 'enrichCancel' })
}

/** Sweep a source's rows for an intel set, recording sightings; streams scan progress via `onPartial`. */
export function sweep(
  tabId: string,
  reqId: number,
  entries: Array<{ value: string; kind: string }>,
  columns: string[] | undefined,
  mode: 'replace' | 'add',
  onPartial: (p: { sightings: number; scanned: number; max: number }) => void
): Promise<{ sightings: number; hits: number } | null> {
  return new Promise<{ sightings: number; hits: number } | null>((resolve, reject) => {
    const id = nextId++
    pending.set(id, {
      resolve: resolve as (v: unknown) => void,
      reject,
      onProgress: (p) => onPartial(p as { sightings: number; scanned: number; max: number })
    })
    w().postMessage({ t: 'sweep', id, tabId, reqId, entries, columns, mode })
  })
}

/** Abort an in-flight sweep for a tab (a newer sweep or a user cancel). */
export function sweepCancel(tabId: string): void {
  worker?.postMessage({ t: 'sweepCancel', tabId })
}

export async function terminateDbWorker(): Promise<void> {
  if (!worker) return
  try {
    await call('closeAll')
  } catch {
    /* ignore */
  }
  await worker.terminate()
  worker = null
}
