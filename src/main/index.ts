import { app, BrowserWindow, ipcMain, dialog, Menu } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { join } from 'path'
import { readFile, writeFile, stat } from 'fs/promises'
import { existsSync } from 'fs'
import { basename } from 'path'
import { registerCsvIpc } from './csv/ipc'
import { registerEnrichIpc } from './enrich/ipc'
import { registerMcpBridge, startMcp, stopMcpServer } from './ai/mcp/bridge'
import { initDbWorker, call as dbCall } from './csv/dbClient'

// The primary application window — popouts forward their pivots back to it.
let mainWindow: BrowserWindow | null = null

/**
 * Lock a window to its own bundle. Defense in depth on top of contextIsolation/sandbox/nodeIntegration:
 * real external links already go through the validated `shell:openExternal` IPC (https only), so the
 * renderer never legitimately opens a new window or navigates to a remote origin. Deny both — a stray
 * `<a target=_blank>` / `window.open`, or a compromised renderer, can neither spawn an unguarded page
 * nor drive the app off its bundle onto an attacker origin.
 */
function hardenWindow(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  win.webContents.on('will-navigate', (e, url) => {
    // Allow only the app's own origin: file:// in prod, the electron-vite dev server in dev. Hash
    // changes (the popout payload, in-app routing) don't fire will-navigate, so this only sees real
    // navigations.
    const allowed = url.startsWith('file:') || (devUrl != null && url.startsWith(devUrl))
    if (!allowed) e.preventDefault()
  })
}

function createWindow(): void {
  // Dev: the running binary is electron.exe, so set the window/taskbar icon explicitly. Prod: the
  // packaged .exe already carries this icon (electron-builder build/icon.ico), so the file isn't
  // bundled into out/ — guard so a missing path is a no-op rather than a warning.
  const iconPath = join(__dirname, '../../build/icon.ico')
  const win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#16131c',
    title: 'pink-lemonade',
    ...(existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  hardenWindow(win)
  win.on('ready-to-show', () => win.show())
  mainWindow = win
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  // Allow Ctrl + mouse-wheel / pinch zoom in addition to the menu accelerators.
  win.webContents.setVisualZoomLevelLimits(1, 3)

  // Dev: electron-vite serves the renderer and sets ELECTRON_RENDERER_URL.
  // Prod: load the bundled HTML from disk (no remote origin). Network access is opt-in, only
  // through user-configured enrichment providers in main (MaxMind is a local file; VT is roadmap).
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    win.loadURL(devUrl)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// A detached pop-out window — the same renderer bundle, but routed (via the URL hash) to render a
// single feature full-window instead of the app (e.g. the Artifact Constellation, which is too
// cramped in the side panel). The payload travels in the hash so the popout is self-contained on
// first paint; it reaches back through IPC only to forward a pivot to the main grid.
function createPopoutWindow(payload: unknown): void {
  const hash = 'popout=' + encodeURIComponent(JSON.stringify(payload))
  const iconPath = join(__dirname, '../../build/icon.ico')
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 600,
    minHeight: 420,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#16131c',
    title: 'pink-lemonade',
    ...(existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  hardenWindow(win)
  win.on('ready-to-show', () => win.show())
  win.webContents.setVisualZoomLevelLimits(1, 3)
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    win.loadURL(`${devUrl}#${hash}`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { hash })
  }
}

// Renderer (any window) asks to open a feature in its own window.
ipcMain.handle('popout:open', (_event, payload: unknown): null => {
  createPopoutWindow(payload)
  return null
})

// A popout relays a grid/doc action (pivot, build-timeline, apply-group, refresh) to the main
// window, which owns the grid + workspace doc state. A pivot also raises the main window to front.
ipcMain.on('popout:relay', (_event, data: unknown) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if ((data as { type?: string })?.type === 'pivot') {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
    mainWindow.webContents.send('popout:relay', data)
  }
})

// IPC: minimal local file open/save. All transforms run in the renderer;
// these handlers exist so users can pull data in from / push results out to disk.
interface OpenResult {
  name: string
  content: string
  size: number
  /** Set when the file can't be opened as a single string (e.g. beyond V8's max length). */
  tooLarge?: boolean
}

ipcMain.handle('file:open', async (): Promise<OpenResult | null> => {
  const result = await dialog.showOpenDialog({ properties: ['openFile'] })
  if (result.canceled || result.filePaths.length === 0) return null
  const path = result.filePaths[0]
  const name = basename(path)
  const { size } = await stat(path)
  try {
    // A file past V8's ~1.07B-char string cap throws here ("Cannot create a string
    // longer than…") — report it instead of crashing the read.
    const content = await readFile(path, 'utf-8')
    return { name, content, size }
  } catch {
    return { name, content: '', size, tooLarge: true }
  }
})

ipcMain.handle(
  'file:save',
  async (_event, { content, defaultName }: { content: string; defaultName?: string }): Promise<string | null> => {
    const name = defaultName || 'pink-lemonade-output.txt'
    const result = await dialog.showSaveDialog({
      defaultPath: name,
      filters: name.toLowerCase().endsWith('.csv')
        ? [{ name: 'CSV', extensions: ['csv'] }, { name: 'All files', extensions: ['*'] }]
        : undefined
    })
    if (result.canceled || !result.filePath) return null
    await writeFile(result.filePath, content, 'utf-8')
    return result.filePath
  }
)

// Minimal menu kept (hidden behind autoHideMenuBar) so the standard zoom
// accelerators work — important under WSLg/HiDPI where text can render small.
// Ctrl/Cmd + =  zoom in · Ctrl/Cmd + -  zoom out · Ctrl/Cmd + 0  reset.
function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        // Ctrl + '=' (the unshifted '+') is the common ask; register it too.
        { role: 'zoomIn', accelerator: 'CommandOrControl+=', visible: false },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'reload' },
        { role: 'toggleDevTools' }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// Single-instance: a second launch must NOT start a competing DB worker or fight for the MCP server's
// fixed port. The first instance keeps the lock; any later launch fails it, focuses the existing
// window, and quits. (A stale .mcp.json pointing at a drifted port used to be caused by exactly this
// kind of contention — now it can't happen.)
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    initDbWorker() // the DB runs in a worker thread so slow queries never freeze the UI
    void dbCall('sweepStaleTempDbs') // clear any temp CSV dbs left by a prior crash
    registerCsvIpc()
    registerEnrichIpc() // threat-intel/enrichment surface (cache DB + providers live in the worker)
    registerMcpBridge() // terminal-driven surface: status query + active-workspace publish
    void startMcp().catch((e) => console.error('MCP server failed to start:', e)) // localhost MCP for the analyst's own Claude Code
    buildMenu()
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

// Best-effort cleanup of connections + temp dbs (also swept on next startup if this doesn't finish).
// Guarded by the lock: a second instance that bailed early never started the worker/server, so it
// must not fire these (the DB proxy would reject with "worker not started").
app.on('before-quit', () => {
  if (!gotSingleInstanceLock) return
  void stopMcpServer()
  void dbCall('closeAll')
  void dbCall('enrichClose')
  void dbCall('wlClose')
})

app.on('window-all-closed', () => {
  if (gotSingleInstanceLock) {
    void dbCall('closeAll')
    void dbCall('enrichClose')
    void dbCall('wlClose')
  }
  if (process.platform !== 'darwin') app.quit()
})
