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
  worker.on('error', (e) => {
    // A worker-level crash fails every in-flight request rather than hanging them.
    for (const [, p] of pending) p.reject(e)
    pending.clear()
  })
}

function w(): Worker {
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

/** Run an ingest (ingestCsv | addSource); `onProgress` fires for each progress tick. */
export function ingest<T = unknown>(
  fn: 'ingestCsv' | 'addSource',
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
}

/** Bulk-enrich indicators against a provider, writing results to the intel DB at `dbPath`; streams
 *  per-indicator progress via `onPartial`. */
export function enrichBulk(
  reqId: number,
  dbPath: string,
  providerId: string,
  items: Array<{ value: string; kind: string }>,
  now: number,
  onPartial: (p: { done: number; total: number; current: string; fromCache: boolean }) => void
): Promise<EnrichBulkResult> {
  return new Promise<EnrichBulkResult>((resolve, reject) => {
    const id = nextId++
    pending.set(id, {
      resolve: resolve as (v: unknown) => void,
      reject,
      onProgress: (p) => onPartial(p as { done: number; total: number; current: string; fromCache: boolean })
    })
    w().postMessage({ t: 'enrich', id, reqId, dbPath, providerId, items, now })
  })
}

/** Abort the in-flight bulk enrichment (a newer run or a user cancel). */
export function enrichCancel(): void {
  worker?.postMessage({ t: 'enrichCancel' })
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
