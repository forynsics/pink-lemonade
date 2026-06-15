// DB worker thread. Owns every SQLite connection and runs all of db.ts here, so a slow query
// (a full-column distinct scan, a sort-index build, …) blocks THIS thread, never the main process
// that drives the window. Main talks to it through dbClient.ts via a small request/response +
// progress protocol. better-sqlite3 is synchronous by design — that's fine in a worker.

import { parentPort, workerData } from 'node:worker_threads'
import * as db from './db'
import * as enrichEngine from '../enrich/engine'
import * as enrichCache from '../enrich/cache'

const port = parentPort
if (!port) throw new Error('worker.ts must run as a worker thread')

const userDataDir = (workerData as { userDataDir: string }).userDataDir
db.initPaths(userDataDir)
enrichCache.initEnrichPaths(userDataDir)

// Plain functions: serializable args in, serializable value out. Run synchronously in the worker.
const FNS: Record<string, (...a: never[]) => unknown> = {
  getWorkspaceDir: db.getWorkspaceDir,
  setWorkspaceDir: db.setWorkspaceDir,
  createWorkspace: db.createWorkspace,
  openWorkspace: db.openWorkspace,
  renameWorkspace: db.renameWorkspace,
  renameSource: db.renameSource,
  removeSource: db.removeSource,
  closeWorkspace: db.closeWorkspace,
  deleteWorkspace: db.deleteWorkspace,
  listTags: db.listTags,
  setTags: db.setTags,
  tagByFilter: db.tagByFilter,
  locateRow: db.locateRow,
  queryRows: db.queryRows,
  ensureSortIndex: db.ensureSortIndex,
  getColumnUniqueValues: db.getColumnUniqueValues,
  getColumnDistinctCount: db.getColumnDistinctCount,
  getColumnLongest: db.getColumnLongest,
  getColumnValues: db.getColumnValues,
  getColumnStats: db.getColumnStats,
  openDb: db.openDb,
  deleteDb: db.deleteDb,
  closeTab: db.closeTab,
  closeAll: db.closeAll,
  sweepStaleTempDbs: db.sweepStaleTempDbs,
  // Enrichment (provider-agnostic): provider list, config, and cache maintenance.
  enrichProviders: enrichEngine.listProviders,
  enrichGetConfig: db.getEnrichConfig,
  enrichSetConfig: db.setEnrichConfig,
  enrichCacheStats: enrichCache.stats,
  enrichCacheClear: enrichCache.clear,
  enrichCacheGet: enrichCache.getMany,
  enrichCacheDelete: enrichCache.deleteMany,
  enrichClose: enrichCache.close
}

// In-flight ingest aborters keyed by cancelKey (tabId for a single import, wsId for a workspace
// source) and the latest count reqId per tab (a newer count supersedes the running one).
const aborters = new Map<string, AbortController>()
const countReq = new Map<string, number>()
const distinctReq = new Map<string, number>()
// Latest enrichment bulk reqId (one Enrichment tab runs at a time). A newer run — or a cancel
// (sets -1, which no positive reqId matches) — supersedes the running one.
let enrichReq = 0

type Msg =
  | { t: 'call'; id: number; fn: string; args: unknown[] }
  | { t: 'ingest'; id: number; fn: 'ingestCsv' | 'addSource'; cancelKey: string; args: Record<string, unknown> }
  | { t: 'cancel'; cancelKey: string }
  | { t: 'count'; id: number; tabId: string; reqId: number; filters?: unknown; search?: string }
  | { t: 'distinct'; id: number; tabId: string; reqId: number; col: string; filters?: unknown; limit: number }
  | { t: 'distinctCancel'; tabId: string }
  | { t: 'enrich'; id: number; reqId: number; providerId: string; items: unknown[]; now: number }
  | { t: 'enrichCancel' }

port.on('message', async (msg: Msg) => {
  try {
    if (msg.t === 'cancel') {
      aborters.get(msg.cancelKey)?.abort()
      return
    }
    if (msg.t === 'call') {
      const fn = FNS[msg.fn]
      if (!fn) throw new Error(`unknown db fn: ${msg.fn}`)
      port.postMessage({ t: 'result', id: msg.id, ok: true, value: fn(...(msg.args as never[])) })
      return
    }
    if (msg.t === 'ingest') {
      const ctrl = new AbortController()
      aborters.set(msg.cancelKey, ctrl)
      try {
        const onProgress = (p: unknown): void => void port.postMessage({ t: 'progress', id: msg.id, payload: p })
        const args = { ...msg.args, onProgress, signal: ctrl.signal }
        const value =
          msg.fn === 'ingestCsv'
            ? await db.ingestCsv(args as Parameters<typeof db.ingestCsv>[0])
            : await db.addSource(args as Parameters<typeof db.addSource>[0])
        port.postMessage({ t: 'result', id: msg.id, ok: true, value })
      } catch (e) {
        // A canceled ingest resolves to null (the IPC layer's existing contract), not an error.
        if (e instanceof db.CsvIngestCanceled) port.postMessage({ t: 'result', id: msg.id, ok: true, value: null })
        else throw e
      } finally {
        aborters.delete(msg.cancelKey)
      }
      return
    }
    if (msg.t === 'count') {
      countReq.set(msg.tabId, msg.reqId)
      const onPartial = (count: number, scanned: number, max: number): void => {
        if (countReq.get(msg.tabId) === msg.reqId) {
          port.postMessage({ t: 'progress', id: msg.id, payload: { count, scanned, max } })
        }
      }
      const isCanceled = (): boolean => countReq.get(msg.tabId) !== msg.reqId
      const value = await db.buildFilterIndex(msg.tabId, msg.filters as never, msg.search ?? '', onPartial, isCanceled)
      port.postMessage({ t: 'result', id: msg.id, ok: true, value })
      return
    }
    if (msg.t === 'distinctCancel') {
      distinctReq.set(msg.tabId, -1) // no positive reqId matches → the running scan aborts
      return
    }
    if (msg.t === 'distinct') {
      distinctReq.set(msg.tabId, msg.reqId)
      const onPartial = (count: number, scanned: number, max: number): void => {
        if (distinctReq.get(msg.tabId) === msg.reqId) {
          port.postMessage({ t: 'progress', id: msg.id, payload: { count, scanned, max } })
        }
      }
      const shouldAbort = (): boolean => distinctReq.get(msg.tabId) !== msg.reqId
      const value = await db.getColumnDistinctChunked(msg.tabId, msg.col, msg.filters as never, msg.limit, onPartial, shouldAbort)
      port.postMessage({ t: 'result', id: msg.id, ok: true, value }) // value is the result or null (canceled)
      return
    }
    if (msg.t === 'enrichCancel') {
      enrichReq = -1 // no positive reqId matches → the running bulk lookup aborts
      return
    }
    if (msg.t === 'enrich') {
      enrichReq = msg.reqId
      const onProgress = (p: enrichEngine.BulkProgress): void => {
        if (enrichReq === msg.reqId) port.postMessage({ t: 'progress', id: msg.id, payload: p })
      }
      const shouldAbort = (): boolean => enrichReq !== msg.reqId
      const value = await enrichEngine.bulkLookup(
        msg.providerId,
        msg.items as enrichEngine.EnrichItem[],
        msg.now,
        onProgress,
        shouldAbort
      )
      port.postMessage({ t: 'result', id: msg.id, ok: true, value })
      return
    }
  } catch (e) {
    const id = (msg as { id?: number }).id
    if (id != null) port.postMessage({ t: 'result', id, ok: false, error: e instanceof Error ? e.message : String(e) })
  }
})
