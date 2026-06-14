import { ipcMain, dialog, BrowserWindow } from 'electron'
import type { WebContents } from 'electron'
import { basename } from 'path'
import {
  ingestCsv,
  queryRows,
  getColumnUniqueValues,
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

  ipcMain.handle('csv:query', (_e, { tabId, opts }: { tabId: string; opts: QueryOpts }) =>
    queryRows(tabId, normalizeOpts(opts))
  )

  ipcMain.handle(
    'csv:distinct',
    (_e, { tabId, col, filters, limit }: { tabId: string; col: string; filters?: Filter[]; limit?: number }) => ({
      rows: getColumnUniqueValues(tabId, col, normalizeFilters(filters), limit),
      truncated: false
    })
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
  return filters
    .filter((f) => f && typeof f.col === 'string')
    .map((f) => ({ col: f.col, op: f.op === 'eq' ? 'eq' : 'like', value: String(f.value ?? '') }))
}
