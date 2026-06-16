import { ipcMain, dialog, BrowserWindow } from 'electron'
import type { WebContents } from 'electron'
import { basename } from 'path'
import * as dbw from './dbClient'
import type { Filter, QueryOpts, Sort } from './sql'
import type { CsvTableMeta, SourceInfo } from './db'

// Registers the csv:* / ws:* IPC surface. Every DB operation is forwarded to the worker thread
// (dbClient) so a slow query never blocks the main process; the renderer only receives small
// result sets. Ingest/count progress streams back over 'csv:progress' / 'csv:count-progress'.

interface OpenResult {
  tabId: string
  sourceName: string
  columns: Array<{ name: string; original: string }>
  rowCount: number
  dbPath: string
}

export function registerCsvIpc(): void {
  // Pick (dialog) and ingest are separate so the renderer shows an import overlay only
  // during ingest — not while the user is still choosing a file.
  ipcMain.handle('csv:pick', (e) => doPick(e.sender))
  ipcMain.handle('csv:ingest', (e, { tabId, path }: { tabId: string; path: string }) =>
    doIngest(e.sender, tabId, path)
  )

  // Abort an in-flight ingest (the worker holds the AbortController, keyed by this id).
  ipcMain.handle('csv:cancel', (_e, { tabId }: { tabId: string }) => {
    dbw.cancel(tabId)
    return { canceled: true }
  })

  ipcMain.handle('csv:query', async (_e, { tabId, opts }: { tabId: string; opts: QueryOpts }) => {
    const o = normalizeOpts(opts)
    // On a large table, build the matching column index before sorting (Scale #3) — without it,
    // a deep sorted scroll re-sorts the whole set per window. One-time, cached. Runs in the worker.
    if (o.sort) await dbw.call('ensureSortIndex', tabId, o.sort.col, !!o.sort.numeric)
    return dbw.call('queryRows', tabId, o)
  })

  // Prepare a filtered/searched view: materialize its matching rowids (Scale #1b) and return the
  // match count. Chunked + cancelable in the worker; the running total streams over
  // 'csv:count-progress'. Resolves with { count } or { canceled } if a newer request superseded it.
  ipcMain.handle(
    'csv:count',
    async (
      e,
      { tabId, reqId, filters, search }: { tabId: string; reqId: number; filters?: Filter[]; search?: string }
    ) => {
      const f = normalizeFilters(filters)
      const s = normalizeSearch(search)
      try {
        const count = await dbw.count(tabId, reqId, f, s ?? '', (p) => {
          if (!e.sender.isDestroyed()) {
            e.sender.send('csv:count-progress', { tabId, reqId, count: p.count, scanned: p.scanned, max: p.max })
          }
        })
        return count == null ? { canceled: true } : { count }
      } catch {
        return { canceled: true }
      }
    }
  )

  // Distinct values + count, computed in cancelable chunks in the worker; the running scan streams
  // progress over 'csv:distinct-progress'. A newer reqId on the same tab supersedes the prior scan.
  ipcMain.handle(
    'csv:distinct',
    async (
      e,
      { tabId, col, filters, limit, reqId }: { tabId: string; col: string; filters?: Filter[]; limit?: number; reqId?: number }
    ) => {
      const f = normalizeFilters(filters)
      const res = await dbw.distinct(tabId, reqId ?? 0, col, f, limit ?? 1000, (p) => {
        if (!e.sender.isDestroyed()) {
          e.sender.send('csv:distinct-progress', { tabId, reqId, scanned: p.scanned, count: p.count, max: p.max })
        }
      })
      return res == null ? { canceled: true } : res
    }
  )
  ipcMain.handle('csv:distinctCancel', (_e, { tabId }: { tabId: string }) => {
    dbw.distinctCancel(tabId)
    return null
  })

  ipcMain.handle('csv:longest', (_e, { tabId, col }: { tabId: string; col: string }) =>
    dbw.call('getColumnLongest', tabId, col)
  )

  // Ordinal of a row (by rowid) in the current unsorted filtered view — re-centers the time-pivot anchor.
  ipcMain.handle(
    'csv:locate',
    (_e, { tabId, rid, filters, search }: { tabId: string; rid: number; filters?: Filter[]; search?: string }) =>
      dbw.call('locateRow', tabId, rid, normalizeFilters(filters), normalizeSearch(search))
  )

  ipcMain.handle(
    'csv:values',
    async (_e, { tabId, col, filters }: { tabId: string; col: string; filters?: Filter[] }) => ({
      values: await dbw.call<string[]>('getColumnValues', tabId, col, normalizeFilters(filters)),
      truncated: false
    })
  )

  ipcMain.handle('csv:stats', (_e, { tabId, col }: { tabId: string; col: string }) =>
    dbw.call('getColumnStats', tabId, col)
  )

  // Export the whole current view (all rows under the active filters/search/sort) to a CSV file.
  // The save dialog runs here (main); the worker streams every matching row to the chosen path so a
  // multi-million-row export neither blocks the UI nor round-trips through the renderer.
  ipcMain.handle(
    'csv:export',
    async (
      e,
      {
        tabId,
        defaultName,
        opts
      }: { tabId: string; defaultName?: string; opts: { filters?: Filter[]; search?: string; sort?: Sort } }
    ): Promise<{ canceled: true } | { path: string; rows: number }> => {
      const win = BrowserWindow.fromWebContents(e.sender)
      const name = defaultName && defaultName.toLowerCase().endsWith('.csv') ? defaultName : `${defaultName || 'export'}.csv`
      const dialogOpts = {
        defaultPath: name,
        filters: [
          { name: 'CSV', extensions: ['csv'] },
          { name: 'All files', extensions: ['*'] }
        ]
      }
      const result = win ? await dialog.showSaveDialog(win, dialogOpts) : await dialog.showSaveDialog(dialogOpts)
      if (result.canceled || !result.filePath) return { canceled: true }
      const o = {
        filters: normalizeFilters(opts?.filters),
        search: normalizeSearch(opts?.search),
        sort: normalizeSort(opts?.sort)
      }
      const res = await dbw.call<{ rows: number }>('exportRows', tabId, o, result.filePath)
      return { path: result.filePath, rows: res.rows }
    }
  )

  ipcMain.handle('csv:close', (_e, { tabId }: { tabId: string }) => dbw.call('closeTab', tabId).then(() => null))

  // ---- Workspaces (capstone): one db holds many sources ----
  ipcMain.handle('ws:create', (_e, { wsId, name }: { wsId: string; name: string }) =>
    dbw.call('createWorkspace', wsId, name)
  )
  ipcMain.handle('ws:open', (_e, { wsId, dbPath }: { wsId: string; dbPath: string }) =>
    dbw.call('openWorkspace', wsId, dbPath)
  )
  ipcMain.handle('ws:close', (_e, { wsId }: { wsId: string }) => dbw.call('closeWorkspace', wsId).then(() => null))
  ipcMain.handle('ws:delete', (_e, { dbPath }: { dbPath: string }) => dbw.call('deleteWorkspace', dbPath).then(() => null))
  ipcMain.handle('ws:addSource', (e, { wsId, path }: { wsId: string; path: string }) =>
    doAddSource(e.sender, wsId, path)
  )
  ipcMain.handle('ws:rename', (_e, { wsId, name }: { wsId: string; name: string }) =>
    dbw.call('renameWorkspace', wsId, name).then(() => null)
  )
  ipcMain.handle('ws:setIntelMode', (_e, { wsId, mode }: { wsId: string; mode: 'global' | 'workspace' }) =>
    dbw.call('setWorkspaceIntelMode', wsId, mode).then(() => null)
  )
  ipcMain.handle('ws:removeSource', (_e, { wsId, sourceId }: { wsId: string; sourceId: number }) =>
    dbw.call('removeSource', wsId, sourceId).then(() => null)
  )
  ipcMain.handle('ws:renameSource', (_e, { wsId, sourceId, name }: { wsId: string; sourceId: number; name: string }) =>
    dbw.call('renameSource', wsId, sourceId, name).then(() => null)
  )

  // Row tags: list all tags for a source, and set/clear a tag on a set of rows.
  ipcMain.handle('ws:tagList', (_e, { wsId, sourceId }: { wsId: string; sourceId: number }) =>
    dbw.call('listTags', wsId, sourceId)
  )
  ipcMain.handle(
    'ws:tagSet',
    (_e, { wsId, sourceId, rids, tag }: { wsId: string; sourceId: number; rids: number[]; tag: string | null }) =>
      dbw.call('setTags', wsId, sourceId, rids, tag).then(() => null)
  )
  // Per-tag counts for the active source under the current filtered view (tag filter excluded).
  ipcMain.handle(
    'csv:tagCounts',
    (_e, { tabId, filters, search }: { tabId: string; filters?: Filter[]; search?: string }) =>
      dbw.call('getTagCounts', tabId, normalizeFilters(filters), normalizeSearch(search))
  )
  // Bulk-tag every row matching the current view (filters + search), or clear if tag is null.
  ipcMain.handle(
    'ws:tagByFilter',
    (
      _e,
      { wsId, sourceId, filters, search, tag }: { wsId: string; sourceId: number; filters?: Filter[]; search?: string; tag: string | null }
    ) =>
      dbw.call('tagByFilter', wsId, sourceId, normalizeFilters(filters), normalizeSearch(search), typeof tag === 'string' ? tag : null)
  )

  // Workspace storage folder (used as the Open-Workspace default + where new workspaces are saved).
  ipcMain.handle('ws:getDir', () => dbw.call('getWorkspaceDir'))
  ipcMain.handle('ws:setDir', (_e, { dir }: { dir: string }) => dbw.call('setWorkspaceDir', dir))
  ipcMain.handle('ws:pickDir', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts = {
      properties: ['openDirectory' as const, 'createDirectory' as const],
      defaultPath: await dbw.call<string>('getWorkspaceDir')
    }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
  })

  // Re-open a persistent session db by path (no re-ingest) — resume on restart or "Open Database…".
  ipcMain.handle('csv:open', async (_e, { tabId, dbPath }: { tabId: string; dbPath: string }): Promise<OpenResult> => {
    const meta = await dbw.call<CsvTableMeta>('openDb', tabId, dbPath)
    return { tabId, sourceName: meta.sourceName, columns: meta.columns, rowCount: meta.rowCount, dbPath: meta.dbPath }
  })

  // Pick a .workspace/.db to open directly. Returns its path, or null if canceled.
  ipcMain.handle('csv:pickDb', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts = {
      properties: ['openFile' as const],
      defaultPath: await dbw.call<string>('getWorkspaceDir'),
      filters: [{ name: 'Pink Lemonade workspace', extensions: ['workspace', 'db'] }]
    }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
  })

  // Delete a session's db files (Home "delete session").
  ipcMain.handle('csv:deleteDb', (_e, { dbPath }: { dbPath: string }) => dbw.call('deleteDb', dbPath).then(() => null))
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
  const meta = await dbw.ingest<CsvTableMeta | null>(
    'ingestCsv',
    { tabId, filePath, sourceName: basename(filePath) },
    tabId,
    (p) => {
      if (!sender.isDestroyed()) sender.send('csv:progress', { tabId, ...p, phase: 'parsing' })
    }
  )
  if (meta == null) return null // canceled
  if (!sender.isDestroyed()) {
    sender.send('csv:progress', { tabId, bytes: 0, rows: meta.rowCount, total: 0, phase: 'done' })
  }
  return { tabId, sourceName: meta.sourceName, columns: meta.columns, rowCount: meta.rowCount, dbPath: meta.dbPath }
}

/** Ingest a CSV as a new source in an open workspace; progress is keyed on the workspace id. */
async function doAddSource(sender: WebContents, wsId: string, filePath: string): Promise<SourceInfo | null> {
  const src = await dbw.ingest<SourceInfo | null>(
    'addSource',
    { wsId, filePath, sourceName: basename(filePath) },
    wsId,
    (p) => {
      if (!sender.isDestroyed()) sender.send('csv:progress', { tabId: wsId, ...p, phase: 'parsing' })
    }
  )
  if (src == null) return null // canceled
  if (!sender.isDestroyed()) {
    sender.send('csv:progress', { tabId: wsId, bytes: 0, rows: src.rowCount, total: 0, phase: 'done' })
  }
  return src
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
    if (!f) continue
    if (f.op === 'tag') {
      const tags = Array.isArray(f.tags) ? f.tags.filter((t) => typeof t === 'string' && t) : []
      if (tags.length > 0) out.push({ op: 'tag', tags })
      continue
    }
    if (typeof f.col !== 'string') continue
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
      const op = f.op === 'eq' ? 'eq' : f.op === 'neq' ? 'neq' : f.op === 'nlike' ? 'nlike' : 'like'
      out.push({ col: f.col, op, value: String(f.value ?? '') })
    }
  }
  return out.length > 0 ? out : undefined
}
