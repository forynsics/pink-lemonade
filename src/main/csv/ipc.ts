import { ipcMain, dialog, BrowserWindow } from 'electron'
import type { WebContents } from 'electron'
import { basename } from 'path'
import {
  ingestCsv,
  queryRows,
  ensureSortIndex,
  buildFilterIndex,
  getColumnUniqueValues,
  getColumnDistinctCount,
  getColumnLongest,
  getColumnValues,
  getColumnStats,
  closeTab,
  CsvIngestCanceled
} from './db'
import type { Filter, QueryOpts, Sort } from './sql'

// Registers the csv:* IPC surface. All heavy work runs here in main; the renderer only
// receives small result sets (a page of rows, a distinct list, stats). Progress during
// ingest is pushed back over the 'csv:progress' event.

interface OpenResult {
  tabId: string
  sourceName: string
  columns: Array<{ name: string; original: string }>
  rowCount: number
  dbPath: string
}

const controllers = new Map<string, AbortController>()
// Latest count request id per tab — a newer csv:count supersedes (aborts) the running one.
const countReq = new Map<string, number>()

export function registerCsvIpc(): void {
  // Pick (dialog) and ingest are separate so the renderer shows an import overlay only
  // during ingest — not while the user is still choosing a file.
  ipcMain.handle('csv:pick', (e) => doPick(e.sender))
  ipcMain.handle('csv:ingest', (e, { tabId, path }: { tabId: string; path: string }) =>
    doIngest(e.sender, tabId, path)
  )

  ipcMain.handle('csv:cancel', (_e, { tabId }: { tabId: string }) => {
    const c = controllers.get(tabId)
    if (c) {
      c.abort()
      return { canceled: true }
    }
    return { canceled: false }
  })

  ipcMain.handle('csv:query', (_e, { tabId, opts }: { tabId: string; opts: QueryOpts }) => {
    const o = normalizeOpts(opts)
    // On a large table, build the matching column index before sorting (Scale #3) — without it,
    // a deep sorted scroll re-sorts the whole set per window (~90s at 12M rows). One-time, cached.
    if (o.sort) ensureSortIndex(tabId, o.sort.col, !!o.sort.numeric)
    return queryRows(tabId, o)
  })

  // Prepare a filtered/searched view: materialize its matching rowids (Scale #1b) so paging is
  // O(1), and return the match count as a byproduct. Chunked + cancelable; reports the running
  // total over 'csv:count-progress' (live count + a scrollbar that grows as it scans); resolves
  // with the final count, or { canceled } if a newer request superseded it. Search is normalized
  // exactly as the query path normalizes it, so the index token matches.
  ipcMain.handle(
    'csv:count',
    async (
      e,
      { tabId, reqId, filters, search }: { tabId: string; reqId: number; filters?: Filter[]; search?: string }
    ) => {
      countReq.set(tabId, reqId)
      const f = normalizeFilters(filters)
      const s = normalizeSearch(search)
      const current = (): boolean => countReq.get(tabId) === reqId && !e.sender.isDestroyed()
      try {
        const count = await buildFilterIndex(
          tabId,
          f,
          s ?? '',
          (c, scanned, max) => {
            if (current()) e.sender.send('csv:count-progress', { tabId, reqId, count: c, scanned, max })
          },
          () => countReq.get(tabId) !== reqId
        )
        return count == null ? { canceled: true } : { count }
      } catch {
        return { canceled: true }
      }
    }
  )

  ipcMain.handle(
    'csv:distinct',
    (_e, { tabId, col, filters, limit }: { tabId: string; col: string; filters?: Filter[]; limit?: number }) => {
      const f = normalizeFilters(filters)
      const rows = getColumnUniqueValues(tabId, col, f, limit)
      const total = getColumnDistinctCount(tabId, col, f) // true count, even if the list is capped
      return { rows, total, truncated: total > rows.length }
    }
  )

  ipcMain.handle('csv:longest', (_e, { tabId, col }: { tabId: string; col: string }) =>
    getColumnLongest(tabId, col)
  )

  ipcMain.handle(
    'csv:values',
    (_e, { tabId, col, filters }: { tabId: string; col: string; filters?: Filter[] }) => ({
      values: getColumnValues(tabId, col, normalizeFilters(filters)),
      truncated: false
    })
  )

  ipcMain.handle('csv:stats', (_e, { tabId, col }: { tabId: string; col: string }) =>
    getColumnStats(tabId, col)
  )

  ipcMain.handle('csv:close', (_e, { tabId }: { tabId: string }) => {
    closeTab(tabId)
    return null
  })
}

async function doPick(sender: WebContents): Promise<{ path: string; sourceName: string } | null> {
  // Test hook: the Playwright driver can't pick a file in the native dialog, so when
  // PL_CSV_TEST_FILE is set we return that path directly. No effect in production.
  if (process.env.PL_CSV_TEST_FILE) {
    const p = process.env.PL_CSV_TEST_FILE
    return { path: p, sourceName: basename(p) }
  }
  const win = BrowserWindow.fromWebContents(sender)
  const dialogOpts = {
    properties: ['openFile' as const],
    filters: [
      { name: 'Tabular data', extensions: ['csv', 'tsv', 'txt', 'log'] },
      { name: 'All files', extensions: ['*'] }
    ]
  }
  const r = win ? await dialog.showOpenDialog(win, dialogOpts) : await dialog.showOpenDialog(dialogOpts)
  if (r.canceled || r.filePaths.length === 0) return null
  return { path: r.filePaths[0], sourceName: basename(r.filePaths[0]) }
}

async function doIngest(sender: WebContents, tabId: string, filePath: string): Promise<OpenResult | null> {
  const controller = new AbortController()
  controllers.set(tabId, controller)
  try {
    const meta = await ingestCsv({
      tabId,
      filePath,
      sourceName: basename(filePath),
      signal: controller.signal,
      onProgress: (p) => {
        if (!sender.isDestroyed()) sender.send('csv:progress', { tabId, ...p, phase: 'parsing' })
      }
    })
    if (!sender.isDestroyed()) {
      sender.send('csv:progress', { tabId, bytes: 0, rows: meta.rowCount, total: 0, phase: 'done' })
    }
    return {
      tabId,
      sourceName: meta.sourceName,
      columns: meta.columns,
      rowCount: meta.rowCount,
      dbPath: meta.dbPath
    }
  } catch (e) {
    if (e instanceof CsvIngestCanceled) return null
    throw e
  } finally {
    controllers.delete(tabId)
  }
}

function normalizeOpts(opts: QueryOpts): QueryOpts {
  return {
    limit: Number(opts?.limit) || 100,
    offset: Number(opts?.offset) || 0,
    sort: normalizeSort(opts?.sort),
    filters: normalizeFilters(opts?.filters),
    search: normalizeSearch(opts?.search)
  }
}

function normalizeSearch(search?: string): string | undefined {
  if (typeof search !== 'string') return undefined
  const t = search.trim()
  return t === '' ? undefined : t
}

function normalizeSort(sort?: Sort): Sort | undefined {
  if (!sort || typeof sort.col !== 'string') return undefined
  return { col: sort.col, dir: sort.dir === 'desc' ? 'desc' : 'asc', numeric: !!sort.numeric }
}

function normalizeFilters(filters?: Filter[]): Filter[] | undefined {
  if (!Array.isArray(filters) || filters.length === 0) return undefined
  const out: Filter[] = []
  for (const f of filters) {
    if (!f || typeof f.col !== 'string') continue
    if (f.op === 'in') {
      const values = Array.isArray(f.values) ? f.values.map(String) : []
      if (values.length > 0) out.push({ col: f.col, op: 'in', values })
    } else if (f.op === 'timearound') {
      const tkind = f.tkind === 'iso' || f.tkind === 'epoch_ms' ? f.tkind : 'epoch_s'
      const deltaSec = Math.max(0, Math.trunc(Number(f.deltaSec)) || 0)
      if (deltaSec > 0) out.push({ col: f.col, op: 'timearound', value: String(f.value ?? ''), tkind, deltaSec })
    } else if (f.op === 'timerange') {
      const tkind = f.tkind === 'iso' || f.tkind === 'epoch_ms' ? f.tkind : 'epoch_s'
      const num = (v: unknown): number | undefined => {
        if (v == null) return undefined
        const n = Number(v)
        return Number.isFinite(n) ? n : undefined
      }
      const from = num(f.from)
      const to = num(f.to)
      if (from != null || to != null) out.push({ col: f.col, op: 'timerange', tkind, from, to })
    } else {
      const op = f.op === 'eq' ? 'eq' : f.op === 'neq' ? 'neq' : 'like'
      out.push({ col: f.col, op, value: String(f.value ?? '') })
    }
  }
  return out.length > 0 ? out : undefined
}
