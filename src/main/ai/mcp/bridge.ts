// Glue between the Electron app and the MCP server (server.ts). Owns the "which workspace is the
// terminal driving" state — mirrored from the renderer's active tab — and fans a tool's mutation out
// to every window so the review panels reload as the agent works.

import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type { WsCtx } from '../types'
import { defaultFolder, provisionFolder } from './provision'
import { getMcpStatus, resetMcpCoverage, startMcpServer, stopMcpServer, type McpStatus } from './server'

const EMPTY_WS: WsCtx = { hasWorkspace: false, sources: [] }
// The workspace the terminal drives: whatever the analyst has focused in the app. The renderer
// republishes this on every active-tab change.
let activeWs: WsCtx = EMPTY_WS

export function getActiveWs(): WsCtx {
  return activeWs
}

// Waiters for an agent-initiated open. The renderer is the single source of truth for "what the
// terminal is driving", so main doesn't keep a competing copy — it asks the renderer to open the
// workspace and waits for that same publish channel to echo it back.
type WsWaiter = { match: (ws: WsCtx) => boolean; resolve: (ws: WsCtx) => void }
const openWaiters = new Set<WsWaiter>()
const OPEN_TIMEOUT_MS = 15000 // generous: opening a large workspace re-registers every source

/** Nudge the renderer, then wait until the context it publishes satisfies `match`. */
function waitForRenderer(match: (ws: WsCtx) => boolean, nudge: (w: BrowserWindow) => void, onTimeout: string): Promise<WsCtx> {
  const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
  if (wins.length === 0) return Promise.reject(new Error('The app window is closed.'))
  if (match(activeWs)) return Promise.resolve(activeWs)
  return new Promise<WsCtx>((resolve, reject) => {
    const waiter: WsWaiter = {
      match,
      resolve: (ws) => {
        clearTimeout(timer)
        openWaiters.delete(waiter)
        resolve(ws)
      }
    }
    const timer = setTimeout(() => {
      openWaiters.delete(waiter)
      reject(new Error(onTimeout))
    }, OPEN_TIMEOUT_MS)
    openWaiters.add(waiter)
    for (const w of wins) nudge(w)
  })
}

/**
 * Ask the app to open a workspace and resolve once the renderer reports it active.
 *
 * Awaiting the round trip is the point. Tools read `activeWs`, which only the renderer publishes, so
 * returning at "open requested" would let the agent's very next call (import_evidence, list_sources)
 * operate on the PREVIOUS workspace — a write landing on the wrong case, silently. If no window
 * answers in time we reject rather than pretending: a create_case that says it succeeded while the
 * agent is still pointed elsewhere is the worst possible outcome.
 */
export function showWorkspace(target: { wsId: string; dbPath: string; name: string }): Promise<WsCtx> {
  return waitForRenderer(
    (ws) => ws.hasWorkspace && ws.wsId === target.wsId,
    (w) => w.webContents.send('ws:open-request', target),
    `The app did not open workspace "${target.name}" in time. Ask the analyst to check the app window.`
  )
}

/**
 * Wait until the renderer's published context actually contains the freshly imported sources.
 *
 * Import writes straight to the workspace DB, but every tool reads the context the RENDERER
 * publishes — and that still holds the pre-import source list until it reloads. Without this wait,
 * import_evidence returns and the agent's very next list_sources / find_rows reports an EMPTY case,
 * which reads as "the import did nothing" rather than "the UI hasn't caught up". So we ask the
 * renderer to reload and only return once the sources are visible to the tools.
 */
export function syncSources(wsId: string, sourceIds: number[]): Promise<WsCtx> {
  return waitForRenderer(
    (ws) => ws.hasWorkspace && ws.wsId === wsId && sourceIds.every((id) => ws.sources.some((s) => s.sourceId === id)),
    (w) => w.webContents.send('ws:mutated', { wsId, tool: 'import_evidence' }),
    'The imported evidence did not become visible in the app in time. It is in the case — ask the analyst to reopen it.'
  )
}

/** Register the renderer-facing IPC (status query + active-workspace publish). */
export function registerMcpBridge(): void {
  ipcMain.handle('mcp:status', () => getMcpStatus())

  ipcMain.on('mcp:setActiveWorkspace', (_e, ws: unknown) => {
    const next = ws && typeof ws === 'object' ? (ws as WsCtx) : EMPTY_WS
    const changed = next.wsId !== activeWs.wsId
    activeWs = next
    // A new workspace is a fresh triage — reset the per-workspace coverage the terminal accumulates.
    if (changed) resetMcpCoverage()
    // Release anything waiting on an agent-initiated open / import becoming visible.
    for (const waiter of [...openWaiters]) if (waiter.match(next)) waiter.resolve(next)
  })

  // Default location for the working folder (shown in the connect UI before the analyst commits).
  ipcMain.handle('mcp:defaultFolder', () => defaultFolder())

  // Let the analyst choose a different directory to provision into.
  ipcMain.handle('mcp:pickFolder', async () => {
    const res = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], title: 'Choose a folder for your Claude Code terminal' })
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
  })

  // Write .mcp.json + CLAUDE.md + pre-approved perms into the folder (default if none given).
  ipcMain.handle('mcp:setupFolder', async (_e, dir?: string) => {
    const target = dir && typeof dir === 'string' ? dir : await defaultFolder()
    return provisionFolder(target)
  })

  // Reveal the folder in the OS file manager.
  ipcMain.handle('mcp:openFolder', async (_e, dir: string) => {
    if (dir && typeof dir === 'string') await shell.openPath(dir)
    return null
  })
}

/** Start the MCP server, wiring it to the live active-workspace + a panel-refresh broadcast. */
export async function startMcp(): Promise<McpStatus> {
  return startMcpServer({
    getActiveWs,
    showWorkspace,
    syncSources,
    onToolMutation: (toolName, wsId) => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send('ws:mutated', { wsId, tool: toolName })
      }
    }
  })
}

export { getMcpStatus, stopMcpServer }
