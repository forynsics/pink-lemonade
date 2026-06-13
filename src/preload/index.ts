import { contextBridge, ipcRenderer } from 'electron'

// The only surface the renderer can reach into the main process through.
// Kept deliberately small; transforms never need it. File I/O is opt-in.
const api = {
  openFile: (): Promise<{ name: string; content: string } | null> =>
    ipcRenderer.invoke('file:open'),
  saveFile: (content: string): Promise<string | null> =>
    ipcRenderer.invoke('file:save', content)
}

contextBridge.exposeInMainWorld('api', api)
