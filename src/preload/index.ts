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
    wsSetIntelMode: (wsId: string, mode: 'global' | 'workspace') => ipcRenderer.invoke('ws:setIntelMode', { wsId, mode }),
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
    tagCounts: (tabId: string, filters?: unknown, search?: string) =>
      ipcRenderer.invoke('csv:tagCounts', { tabId, filters, search }),
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
    // Intel sweep: scan a source for an intel set → sightings (intel_hits), with scan progress + cancel.
    sweep: (
      tabId: string,
      reqId: number,
      entries: Array<{ value: string; kind: string }>,
      columns?: string[],
      mode?: 'replace' | 'add'
    ) => ipcRenderer.invoke('csv:sweep', { tabId, reqId, entries, columns, mode }),
    sweepCancel: (tabId: string) => ipcRenderer.invoke('csv:sweepCancel', { tabId }),
    onSweepProgress: (cb: (p: unknown) => void) => {
      const h = (_e: unknown, p: unknown): void => cb(p)
      ipcRenderer.on('csv:sweep-progress', h)
      return () => ipcRenderer.removeListener('csv:sweep-progress', h)
    },
    sightingList: (wsId: string, sourceId: number) => ipcRenderer.invoke('csv:sightingList', { wsId, sourceId }),
    sightingSummary: (wsId: string, sourceId: number) => ipcRenderer.invoke('csv:sightingSummary', { wsId, sourceId }),
    sightingClear: (wsId: string, sourceId: number, opts?: { indicator?: string; rid?: number }) =>
      ipcRenderer.invoke('csv:sightingClear', { wsId, sourceId, indicator: opts?.indicator, rid: opts?.rid }),
    longest: (tabId: string, col: string) => ipcRenderer.invoke('csv:longest', { tabId, col }),
    locate: (tabId: string, rid: number, filters: unknown, search: string | undefined) =>
      ipcRenderer.invoke('csv:locate', { tabId, rid, filters, search }),
    values: (tabId: string, col: string, filters?: unknown) =>
      ipcRenderer.invoke('csv:values', { tabId, col, filters }),
    stats: (tabId: string, col: string) => ipcRenderer.invoke('csv:stats', { tabId, col }),
    export: (tabId: string, defaultName: string | undefined, opts: unknown) =>
      ipcRenderer.invoke('csv:export', { tabId, defaultName, opts }),
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
    pickMmdb: () => ipcRenderer.invoke('enrich:pickMmdb'),
    // MaxMind "set it up for me": download GeoLite2 with the user's free key (key stored encrypted).
    hasKey: () => ipcRenderer.invoke('enrich:hasKey'),
    maxmindSetup: (key: string | undefined, editions?: string[]) =>
      ipcRenderer.invoke('enrich:maxmindSetup', { key, editions }),
    // VirusTotal: paste a key — main validates it + auto-detects the tier/quota, then stores it
    // encrypted. The key never comes back to the renderer (only the detected tier does).
    vtHasKey: () => ipcRenderer.invoke('enrich:vtHasKey'),
    vtSetKey: (key: string) => ipcRenderer.invoke('enrich:vtSetKey', { key }),
    vtGetSettings: () => ipcRenderer.invoke('enrich:vtGetSettings'),
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
    cacheCount: (dbPath: string) => ipcRenderer.invoke('enrich:cacheCount', { dbPath }),
    cacheGet: (dbPath: string, indicators: string[]) => ipcRenderer.invoke('enrich:cacheGet', { dbPath, indicators }),
    cacheDump: (dbPath: string, limit?: number) => ipcRenderer.invoke('enrich:cacheDump', { dbPath, limit }),
    cacheDelete: (dbPath: string, indicators: string[]) => ipcRenderer.invoke('enrich:cacheDelete', { dbPath, indicators }),
    // Subscribe to bulk-lookup progress; returns a disposer (contextBridge can't pass the listener back).
    onProgress: (cb: (p: unknown) => void) => {
      const h = (_e: unknown, p: unknown): void => cb(p)
      ipcRenderer.on('enrich:progress', h)
      return () => ipcRenderer.removeListener('enrich:progress', h)
    },
    // Open a URL in the default browser (e.g. "View on VirusTotal").
    openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', { url })
  },

  // Watchlists: the analyst's curated context lists (global, app-wide), edited in the Watchlists
  // drawer and matched by the 'watchlist' enrichment provider.
  watchlist: {
    list: () => ipcRenderer.invoke('watchlist:list'),
    entries: (id: number) => ipcRenderer.invoke('watchlist:entries', { id }),
    create: (name: string, kind: string, color?: string | null) =>
      ipcRenderer.invoke('watchlist:create', { name, kind, color }),
    rename: (id: number, name: string) => ipcRenderer.invoke('watchlist:rename', { id, name }),
    remove: (id: number) => ipcRenderer.invoke('watchlist:delete', { id }),
    replace: (id: number, text: string) => ipcRenderer.invoke('watchlist:replace', { id, text })
  }
}

contextBridge.exposeInMainWorld('api', api)
