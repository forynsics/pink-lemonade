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
    ingest: (tabId: string, path: string) => ipcRenderer.invoke('csv:ingest', { tabId, path }),
    cancel: (tabId: string) => ipcRenderer.invoke('csv:cancel', { tabId }),
    query: (tabId: string, opts: unknown) => ipcRenderer.invoke('csv:query', { tabId, opts }),
    distinct: (tabId: string, col: string, filters?: unknown, limit?: number) =>
      ipcRenderer.invoke('csv:distinct', { tabId, col, filters, limit }),
    values: (tabId: string, col: string, filters?: unknown) =>
      ipcRenderer.invoke('csv:values', { tabId, col, filters }),
    stats: (tabId: string, col: string) => ipcRenderer.invoke('csv:stats', { tabId, col }),
    close: (tabId: string) => ipcRenderer.invoke('csv:close', { tabId }),
    // Subscribe to ingest progress; returns a disposer (contextBridge can't pass the listener back).
    onProgress: (cb: (p: unknown) => void) => {
      const h = (_e: unknown, p: unknown): void => cb(p)
      ipcRenderer.on('csv:progress', h)
      return () => ipcRenderer.removeListener('csv:progress', h)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)
