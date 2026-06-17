import { ipcMain, dialog, BrowserWindow, app, safeStorage, shell } from 'electron'
import { join } from 'path'
import { mkdirSync } from 'fs'
import * as dbw from '../csv/dbClient'
import { downloadEdition, DEFAULT_EDITIONS } from './maxmindSetup'
import { VT_API_BASE, deriveTier } from './providers/vtShared'

// Registers the enrich:* IPC surface. Like csv:*, every op is forwarded to the worker thread
// (which owns the cache DB and runs the providers) so a slow lookup never blocks the main process.
// The bulk lookup streams per-indicator progress over 'enrich:progress'. File dialogs, the MaxMind
// download, and the license-key (safeStorage) all stay in main — the worker is SQLite-only.

function geoipDir(): string {
  return join(app.getPath('userData'), 'geoip')
}
// Default folder for user intel DBs (open/create dialogs default here).
function intelDir(): string {
  const d = join(app.getPath('userData'), 'intel')
  mkdirSync(d, { recursive: true })
  return d
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
  // All cache ops are scoped to a specific intel DB file (dbPath).
  ipcMain.handle('enrich:defaultDb', () => dbw.call('enrichDefaultDb'))
  ipcMain.handle('enrich:cacheCount', (_e, { dbPath }: { dbPath: string }) => dbw.call('enrichCacheCount', dbPath))
  // Cache READ only (no provider call) — load what's already known for these indicators.
  ipcMain.handle('enrich:cacheGet', (_e, { dbPath, indicators }: { dbPath: string; indicators: string[] }) =>
    dbw.call('enrichCacheGet', dbPath, indicators ?? [])
  )
  // Load every entry in the DB (capped) — powers "Load all from DB". Fallback limit only; the
  // renderer passes its own LOAD_CAP. Keep this in sync with DUMP_CAP / LOAD_CAP.
  ipcMain.handle('enrich:cacheDump', (_e, { dbPath, limit }: { dbPath: string; limit?: number }) =>
    dbw.call('enrichCacheDump', dbPath, limit ?? 50000)
  )
  // Drop all cached results (every provider) for these indicators — so the next enrich is fresh.
  ipcMain.handle('enrich:cacheDelete', (_e, { dbPath, indicators }: { dbPath: string; indicators: string[] }) =>
    dbw.call('enrichCacheDelete', dbPath, indicators ?? []).then(() => null)
  )

  // Open an existing intel DB file, or create a new one. Both just return a path; the file + table
  // are created lazily on first cache op.
  ipcMain.handle('enrich:openDb', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts = {
      properties: ['openFile' as const],
      defaultPath: intelDir(),
      filters: [{ name: 'Intel database', extensions: ['db'] }, { name: 'All files', extensions: ['*'] }]
    }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
  })
  ipcMain.handle('enrich:newDb', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts = {
      defaultPath: join(intelDir(), 'intel.db'),
      filters: [{ name: 'Intel database', extensions: ['db'] }]
    }
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    return r.canceled || !r.filePath ? null : r.filePath
  })

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

  // --- VirusTotal key handling (safeStorage-only; the key never reaches the renderer/worker plaintext) ---

  // Whether a VirusTotal API key is stored.
  ipcMain.handle('enrich:vtHasKey', async () => {
    const c = await dbw.call<Record<string, unknown>>('enrichGetConfig')
    return typeof c.vtKeyEnc === 'string' && c.vtKeyEnc !== ''
  })

  // The auto-detected pace/quota (read-only) for the renderer's run estimate.
  ipcMain.handle('enrich:vtGetSettings', async () => {
    const c = await dbw.call<Record<string, unknown>>('enrichGetConfig')
    return {
      requestsPerMinute: typeof c.vtRequestsPerMinute === 'number' ? c.vtRequestsPerMinute : 4,
      dailyQuota: typeof c.vtDailyQuota === 'number' ? c.vtDailyQuota : null
    }
  })

  // Save (or clear) the VirusTotal key. The user just pastes their key — we validate it AND detect
  // its tier/quotas in one authenticated request (GET /users/{key}), then store the key encrypted and
  // the detected pace. No plaintext fallback: if safeStorage is unavailable we refuse to store.
  ipcMain.handle('enrich:vtSetKey', async (_e, { key }: { key?: string }) => {
    const k = (key ?? '').trim()
    if (!k) {
      await dbw.call('enrichSetConfig', { vtKeyEnc: '', vtRequestsPerMinute: undefined, vtDailyQuota: undefined })
      return { ok: true }
    }
    // Validate + detect quotas. The key is the user's own id for the users endpoint.
    let res: Response
    try {
      res = await fetch(`${VT_API_BASE}/users/${encodeURIComponent(k)}`, {
        headers: { 'x-apikey': k, accept: 'application/json' },
        signal: AbortSignal.timeout(15_000)
      })
    } catch {
      return { ok: false, error: 'Could not verify key (network error)' }
    }
    if (res.status === 401 || res.status === 403) return { ok: false, error: 'Invalid API key' }
    if (res.status === 429) return { ok: false, error: 'Could not verify key (rate limited) — try again shortly' }
    if (!res.ok) return { ok: false, error: `Could not verify key (HTTP ${res.status})` }

    let tier: ReturnType<typeof deriveTier>
    try {
      const body = (await res.json()) as { data?: { attributes?: Record<string, unknown> } }
      tier = deriveTier(body?.data?.attributes)
    } catch {
      tier = deriveTier(undefined) // safe free-tier default
    }

    const enc = encryptKey(k)
    if (!enc) return { ok: false, error: 'Secure storage unavailable' }
    await dbw.call('enrichSetConfig', {
      vtKeyEnc: enc,
      vtRequestsPerMinute: tier.requestsPerMinute,
      vtDailyQuota: tier.dailyQuota ?? undefined
    })
    return { ok: true, tier: tier.tier, dailyQuota: tier.dailyQuota, requestsPerMinute: tier.requestsPerMinute }
  })

  // Open a URL in the user's default browser (e.g. "View on VirusTotal").
  ipcMain.handle('shell:openExternal', async (_e, { url }: { url: string }) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) await shell.openExternal(url)
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
      { reqId, dbPath, providerId, items }: { reqId: number; dbPath: string; providerId: string; items: Array<{ value: string; kind: string }> }
    ) => {
      // Network providers (VirusTotal) need their secret decrypted here in main and injected per run —
      // the worker has no safeStorage. The key stays a local var: never logged, never returned.
      let secrets: { apiKey?: string; requestsPerMinute?: number } | undefined
      if (providerId === 'virustotal') {
        const c = await dbw.call<Record<string, unknown>>('enrichGetConfig')
        const apiKey = typeof c.vtKeyEnc === 'string' && c.vtKeyEnc ? (decryptKey(c.vtKeyEnc) ?? undefined) : undefined
        secrets = { apiKey, requestsPerMinute: typeof c.vtRequestsPerMinute === 'number' ? c.vtRequestsPerMinute : 4 }
      }
      return dbw.enrichBulk(
        reqId,
        dbPath,
        providerId,
        items ?? [],
        Date.now(),
        (p) => {
          if (!e.sender.isDestroyed()) {
            e.sender.send('enrich:progress', { reqId, ...p })
          }
        },
        secrets
      )
    }
  )

  ipcMain.handle('enrich:cancel', () => {
    dbw.enrichCancel()
    return null
  })

  // Watchlists (global, app-wide) — the analyst's curated context lists. All forwarded to the worker
  // (which owns watchlists.db). `now` is stamped in main so the store stays clock-free.
  ipcMain.handle('watchlist:list', () => dbw.call('wlListLists'))
  ipcMain.handle('watchlist:entries', (_e, { id }: { id: number }) => dbw.call('wlGetEntries', id))
  ipcMain.handle('watchlist:create', (_e, { name, kind, color }: { name: string; kind: string; color?: string | null }) =>
    dbw.call('wlCreate', name, kind, color ?? null, Date.now())
  )
  ipcMain.handle('watchlist:rename', (_e, { id, name }: { id: number; name: string }) =>
    dbw.call('wlRename', id, name, Date.now()).then(() => null)
  )
  ipcMain.handle('watchlist:delete', (_e, { id }: { id: number }) => dbw.call('wlDelete', id).then(() => null))
  ipcMain.handle('watchlist:replace', (_e, { id, text }: { id: number; text: string }) =>
    dbw.call('wlReplace', id, text, Date.now())
  )
}
