import { app, BrowserWindow, ipcMain, dialog, Menu } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { join } from 'path'
import { readFile, writeFile, stat } from 'fs/promises'
import { basename } from 'path'
import { registerCsvIpc } from './csv/ipc'
import { sweepStaleTempDbs, closeAll } from './csv/db'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#16131c',
    title: 'pink-lemonade',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.on('ready-to-show', () => win.show())

  // Allow Ctrl + mouse-wheel / pinch zoom in addition to the menu accelerators.
  win.webContents.setVisualZoomLevelLimits(1, 3)

  // Dev: electron-vite serves the renderer and sets ELECTRON_RENDERER_URL.
  // Prod: load the bundled HTML from disk. The app makes no network requests.
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    win.loadURL(devUrl)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

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

ipcMain.handle('file:save', async (_event, content: string): Promise<string | null> => {
  const result = await dialog.showSaveDialog({ defaultPath: 'pink-lemonade-output.txt' })
  if (result.canceled || !result.filePath) return null
  await writeFile(result.filePath, content, 'utf-8')
  return result.filePath
})

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

app.whenReady().then(() => {
  sweepStaleTempDbs() // clear any temp CSV dbs left by a prior crash
  registerCsvIpc()
  buildMenu()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => closeAll())

app.on('window-all-closed', () => {
  closeAll() // delete temp CSV dbs
  if (process.platform !== 'darwin') app.quit()
})
