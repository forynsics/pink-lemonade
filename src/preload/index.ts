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
  saveFile: (content: string): Promise<string | null> =>
    ipcRenderer.invoke('file:save', content),

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
  }
}

contextBridge.exposeInMainWorld('api', api)
