import { ipcMain, dialog, BrowserWindow, app, safeStorage } from 'electron'
import { join } from 'path'
import * as dbw from '../csv/dbClient'
import { downloadEdition, DEFAULT_EDITIONS } from './maxmindSetup'

// Registers the enrich:* IPC surface. Like csv:*, every op is forwarded to the worker thread
// (which owns the cache DB and runs the providers) so a slow lookup never blocks the main process.
// The bulk lookup streams per-indicator progress over 'enrich:progress'. File dialogs, the MaxMind
// download, and the license-key (safeStorage) all stay in main — the worker is SQLite-only.

function geoipDir(): string {
  return join(app.getPath('userData'), 'geoip')
}

/** Encrypt the license key at rest (Electron safeStorage / OS keychain). null if unavailable. */
function encryptKey(plain: string): string | null {
  if (!safeStorage.isEncryptionAvailable()) return null
  return safeStorage.encryptString(plain).toString('base64')
}
function decryptKey(b64: string): string | null {
  try {
    return safeStorage.decryptString(Buffer.from(b64, 'base64'))
  } catch {
    return null
  }
}

export function registerEnrichIpc(): void {
  ipcMain.handle('enrich:providers', () => dbw.call('enrichProviders'))
  ipcMain.handle('enrich:getConfig', () => dbw.call('enrichGetConfig'))
  ipcMain.handle('enrich:setConfig', (_e, { patch }: { patch: Record<string, unknown> }) =>
    dbw.call('enrichSetConfig', patch)
  )
  ipcMain.handle('enrich:cacheStats', () => dbw.call('enrichCacheStats'))
  // Cache READ only (no provider call) — load what's already known for these indicators.
  ipcMain.handle('enrich:cacheGet', (_e, { indicators }: { indicators: string[] }) =>
    dbw.call('enrichCacheGet', indicators ?? [])
  )
  // Drop all cached results (every provider) for these indicators — so the next enrich is fresh.
  ipcMain.handle('enrich:cacheDelete', (_e, { indicators }: { indicators: string[] }) =>
    dbw.call('enrichCacheDelete', indicators ?? []).then(() => null)
  )
  ipcMain.handle('enrich:cacheClear', (_e, { provider }: { provider?: string | null }) =>
    dbw.call('enrichCacheClear', provider ?? null).then(() => null)
  )

  // Manual fallback: pick a .mmdb yourself (e.g. you already have one). Sets the City slot.
  ipcMain.handle('enrich:pickMmdb', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts = {
      properties: ['openFile' as const],
      filters: [{ name: 'MaxMind database', extensions: ['mmdb'] }]
    }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (r.canceled || r.filePaths.length === 0) return null
    const path = r.filePaths[0]
    await dbw.call('enrichSetConfig', { maxmindCityPath: path })
    return path
  })

  // Whether a MaxMind license key is already stored (so the UI can offer "Update" without re-asking).
  ipcMain.handle('enrich:hasKey', async () => {
    const c = await dbw.call<Record<string, unknown>>('enrichGetConfig')
    return (typeof c.maxmindKeyEnc === 'string' && c.maxmindKeyEnc !== '') || typeof c.maxmindKeyPlain === 'string'
  })
  ipcMain.handle('enrich:clearKey', async () => {
    await dbw.call('enrichSetConfig', { maxmindKeyEnc: '', maxmindKeyPlain: '' })
    return null
  })

  // The "set it up for me" helper: download + install GeoLite2 (City + ASN) with the user's free
  // license key. Persists the key encrypted; streams per-edition progress over 'enrich:setup-progress'.
  ipcMain.handle(
    'enrich:maxmindSetup',
    async (e, { key, editions }: { key?: string; editions?: string[] }) => {
      const cfg = await dbw.call<Record<string, unknown>>('enrichGetConfig')

      // Resolve the license key: a freshly-pasted one (persist it) or the stored encrypted one.
      let licenseKey = (key ?? '').trim()
      if (licenseKey) {
        const enc = encryptKey(licenseKey)
        // On Windows safeStorage (DPAPI) is always available; the plaintext fallback is last-resort.
        await dbw.call('enrichSetConfig', enc ? { maxmindKeyEnc: enc, maxmindKeyPlain: '' } : { maxmindKeyPlain: licenseKey })
      } else if (typeof cfg.maxmindKeyEnc === 'string' && cfg.maxmindKeyEnc) {
        licenseKey = decryptKey(cfg.maxmindKeyEnc) ?? ''
      } else if (typeof cfg.maxmindKeyPlain === 'string') {
        licenseKey = cfg.maxmindKeyPlain
      }
      if (!licenseKey) return { ok: false, error: 'No license key provided' }

      const want = editions && editions.length > 0 ? editions : [...DEFAULT_EDITIONS]
      const dir = geoipDir()
      const installed: Array<{ editionId: string; path: string }> = []
      try {
        for (const ed of want) {
          const path = await downloadEdition(ed, licenseKey, dir, (p) => {
            if (!e.sender.isDestroyed()) e.sender.send('enrich:setup-progress', p)
          })
          installed.push({ editionId: ed, path })
        }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }

      const patch: Record<string, unknown> = {}
      for (const i of installed) {
        if (i.editionId.includes('City')) patch.maxmindCityPath = i.path
        if (i.editionId.includes('ASN')) patch.maxmindAsnPath = i.path
      }
      await dbw.call('enrichSetConfig', patch)
      return { ok: true, installed }
    }
  )

  // Bulk lookup: chunked + cancelable in the worker; the running scan streams over 'enrich:progress'.
  // A newer reqId (or enrich:cancel) supersedes the prior run. Resolves with { rows } or { rows, canceled }.
  ipcMain.handle(
    'enrich:bulk',
    async (
      e,
      { reqId, providerId, items }: { reqId: number; providerId: string; items: Array<{ value: string; kind: string }> }
    ) => {
      return dbw.enrichBulk(reqId, providerId, items ?? [], Date.now(), (p) => {
        if (!e.sender.isDestroyed()) {
          e.sender.send('enrich:progress', { reqId, ...p })
        }
      })
    }
  )

  ipcMain.handle('enrich:cancel', () => {
    dbw.enrichCancel()
    return null
  })
}
