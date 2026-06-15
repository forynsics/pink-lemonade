import { contextBridge, ipcRenderer } from 'electron'

// The only surface the renderer can reach into the main process through.
// Kept deliberately small; transforms never need it. File I/O is opt-in.
const api = {
  openFile: (): Promise<{
    name: string
    content: string
    size: number
    tooLarge?: boolean
  } | null> => ipcRenderer.invoke('file:open'),
  saveFile: (content: string, defaultName?: string): Promise<string | null> =>
    ipcRenderer.invoke('file:save', { content, defaultName }),

  // CSV viewer: data lives in a main-process SQLite db; these return only small result sets.
  csv: {
    pick: () => ipcRenderer.invoke('csv:pick'),
    pickDb: () => ipcRenderer.invoke('csv:pickDb'),
    ingest: (tabId: string, path: string) => ipcRenderer.invoke('csv:ingest', { tabId, path }),
    open: (tabId: string, dbPath: string) => ipcRenderer.invoke('csv:open', { tabId, dbPath }),
    deleteDb: (dbPath: string) => ipcRenderer.invoke('csv:deleteDb', { dbPath }),
    // Workspaces (capstone): one db holds many sources.
    wsCreate: (wsId: string, name: string) => ipcRenderer.invoke('ws:create', { wsId, name }),
    wsOpen: (wsId: string, dbPath: string) => ipcRenderer.invoke('ws:open', { wsId, dbPath }),
    wsClose: (wsId: string) => ipcRenderer.invoke('ws:close', { wsId }),
    wsDelete: (dbPath: string) => ipcRenderer.invoke('ws:delete', { dbPath }),
    wsAddSource: (wsId: string, path: string) => ipcRenderer.invoke('ws:addSource', { wsId, path }),
    wsRename: (wsId: string, name: string) => ipcRenderer.invoke('ws:rename', { wsId, name }),
    wsRemoveSource: (wsId: string, sourceId: number) => ipcRenderer.invoke('ws:removeSource', { wsId, sourceId }),
    wsRenameSource: (wsId: string, sourceId: number, name: string) =>
      ipcRenderer.invoke('ws:renameSource', { wsId, sourceId, name }),
    wsGetDir: () => ipcRenderer.invoke('ws:getDir'),
    wsSetDir: (dir: string) => ipcRenderer.invoke('ws:setDir', { dir }),
    wsPickDir: () => ipcRenderer.invoke('ws:pickDir'),
    wsTagList: (wsId: string, sourceId: number) => ipcRenderer.invoke('ws:tagList', { wsId, sourceId }),
    wsTagSet: (wsId: string, sourceId: number, rids: number[], tag: string | null) =>
      ipcRenderer.invoke('ws:tagSet', { wsId, sourceId, rids, tag }),
    wsTagByFilter: (wsId: string, sourceId: number, filters: unknown, search: string | undefined, tag: string | null) =>
      ipcRenderer.invoke('ws:tagByFilter', { wsId, sourceId, filters, search, tag }),
    cancel: (tabId: string) => ipcRenderer.invoke('csv:cancel', { tabId }),
    query: (tabId: string, opts: unknown) => ipcRenderer.invoke('csv:query', { tabId, opts }),
    count: (tabId: string, reqId: number, filters?: unknown, search?: string) =>
      ipcRenderer.invoke('csv:count', { tabId, reqId, filters, search }),
    distinct: (tabId: string, col: string, filters?: unknown, limit?: number, reqId?: number) =>
      ipcRenderer.invoke('csv:distinct', { tabId, col, filters, limit, reqId }),
    distinctCancel: (tabId: string) => ipcRenderer.invoke('csv:distinctCancel', { tabId }),
    onDistinctProgress: (cb: (p: unknown) => void) => {
      const h = (_e: unknown, p: unknown): void => cb(p)
      ipcRenderer.on('csv:distinct-progress', h)
      return () => ipcRenderer.removeListener('csv:distinct-progress', h)
    },
    longest: (tabId: string, col: string) => ipcRenderer.invoke('csv:longest', { tabId, col }),
    locate: (tabId: string, rid: number, filters: unknown, search: string | undefined) =>
      ipcRenderer.invoke('csv:locate', { tabId, rid, filters, search }),
    values: (tabId: string, col: string, filters?: unknown) =>
      ipcRenderer.invoke('csv:values', { tabId, col, filters }),
    stats: (tabId: string, col: string) => ipcRenderer.invoke('csv:stats', { tabId, col }),
    close: (tabId: string) => ipcRenderer.invoke('csv:close', { tabId }),
    // Subscribe to ingest progress; returns a disposer (contextBridge can't pass the listener back).
    onProgress: (cb: (p: unknown) => void) => {
      const h = (_e: unknown, p: unknown): void => cb(p)
      ipcRenderer.on('csv:progress', h)
      return () => ipcRenderer.removeListener('csv:progress', h)
    },
    // Subscribe to live match-count progress (Scale #2). Returns a disposer.
    onCountProgress: (cb: (p: unknown) => void) => {
      const h = (_e: unknown, p: unknown): void => cb(p)
      ipcRenderer.on('csv:count-progress', h)
      return () => ipcRenderer.removeListener('csv:count-progress', h)
    }
  },

  // Threat-intel / enrichment: bulk-look-up indicators against a provider (MaxMind, …). The
  // cache DB + providers live in the worker; results stream back over 'enrich:progress'.
  enrich: {
    providers: () => ipcRenderer.invoke('enrich:providers'),
    getConfig: () => ipcRenderer.invoke('enrich:getConfig'),
    setConfig: (patch: Record<string, unknown>) => ipcRenderer.invoke('enrich:setConfig', { patch }),
    pickMmdb: () => ipcRenderer.invoke('enrich:pickMmdb'),
    // MaxMind "set it up for me": download GeoLite2 with the user's free key (key stored encrypted).
    hasKey: () => ipcRenderer.invoke('enrich:hasKey'),
    clearKey: () => ipcRenderer.invoke('enrich:clearKey'),
    maxmindSetup: (key: string | undefined, editions?: string[]) =>
      ipcRenderer.invoke('enrich:maxmindSetup', { key, editions }),
    onSetupProgress: (cb: (p: unknown) => void) => {
      const h = (_e: unknown, p: unknown): void => cb(p)
      ipcRenderer.on('enrich:setup-progress', h)
      return () => ipcRenderer.removeListener('enrich:setup-progress', h)
    },
    defaultDb: () => ipcRenderer.invoke('enrich:defaultDb'),
    openDb: () => ipcRenderer.invoke('enrich:openDb'),
    newDb: () => ipcRenderer.invoke('enrich:newDb'),
    bulk: (reqId: number, dbPath: string, providerId: string, items: Array<{ value: string; kind: string }>) =>
      ipcRenderer.invoke('enrich:bulk', { reqId, dbPath, providerId, items }),
    cancel: () => ipcRenderer.invoke('enrich:cancel'),
    cacheStats: (dbPath: string) => ipcRenderer.invoke('enrich:cacheStats', { dbPath }),
    cacheCount: (dbPath: string) => ipcRenderer.invoke('enrich:cacheCount', { dbPath }),
    cacheClear: (dbPath: string, provider?: string | null) => ipcRenderer.invoke('enrich:cacheClear', { dbPath, provider }),
    cacheGet: (dbPath: string, indicators: string[]) => ipcRenderer.invoke('enrich:cacheGet', { dbPath, indicators }),
    cacheDump: (dbPath: string, limit?: number) => ipcRenderer.invoke('enrich:cacheDump', { dbPath, limit }),
    cacheDelete: (dbPath: string, indicators: string[]) => ipcRenderer.invoke('enrich:cacheDelete', { dbPath, indicators }),
    // Subscribe to bulk-lookup progress; returns a disposer (contextBridge can't pass the listener back).
    onProgress: (cb: (p: unknown) => void) => {
      const h = (_e: unknown, p: unknown): void => cb(p)
      ipcRenderer.on('enrich:progress', h)
      return () => ipcRenderer.removeListener('enrich:progress', h)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)
