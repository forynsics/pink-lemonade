import { app, BrowserWindow, ipcMain, dialog, Menu } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { join } from 'path'
import { readFile, writeFile } from 'fs/promises'
import { basename } from 'path'

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
ipcMain.handle('file:open', async (): Promise<{ name: string; content: string } | null> => {
  const result = await dialog.showOpenDialog({ properties: ['openFile'] })
  if (result.canceled || result.filePaths.length === 0) return null
  const path = result.filePaths[0]
  const content = await readFile(path, 'utf-8')
  return { name: basename(path), content }
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
  buildMenu()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
