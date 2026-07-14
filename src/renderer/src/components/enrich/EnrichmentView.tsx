import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Database, Download, FilePlus, FolderOpen, KeyRound, ListChecks, ListTree, Loader2, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { classifyIndicator } from '../../tools/ioc/classify'
import { WatchlistsPanel } from './WatchlistsPanel'
import { IntelGrid } from './IntelGrid'
import type { EnrichmentDoc } from '../../state/documents'
import type { EnrichCachedRow, EnrichItem, EnrichProgress, EnrichProviderInfo, EnrichResultRow } from '../../state/enrichTypes'

// The dedicated Enrichment tab: a curated list of indicators (rows) × threat-intel providers
// (column "buckets"). You ADD indicators to the list (no lookup), then SELECT rows and right-click →
// "Enrich with <provider>" to run a given provider against just those rows. Providers run
// independently and accumulate side-by-side, so one pane compares every provider per indicator.
// Lookups are cache-first in the worker; the indicator list persists, results re-read on demand.

// indicator value -> providerId -> that provider's result
type ResultMap = Record<string, Record<string, EnrichResultRow>>

// Max entries "Load all" pulls in. The Intel grid is virtualized, so this is bounded by the in-JS
// TanStack models (filter/sort/facet over the full array), not by the DOM. Keep in sync with
// DUMP_CAP (cache.ts) and the enrich:cacheDump ipc fallback.
const LOAD_CAP = 50000

let lookupCounter = 1

// Canonical indicator form, mirroring the VirusTotal provider's normalizeValue: hashes are lowercased
// so case variants share one list row / cache entry / result (the engine stores the normalized value,
// so the list value must match it). IPs and domains are left as-is.
function canonicalIndicator(value: string, kind: EnrichItem['kind']): string {
  return kind === 'md5' || kind === 'sha1' || kind === 'sha256' ? value.toLowerCase() : value
}

export function EnrichmentView({
  doc,
  visible,
  defaultDbPath,
  onPatch,
  onOpenIntelDb,
  onNewIntelDb,
  onSweep
}: {
  doc: EnrichmentDoc
  visible: boolean
  defaultDbPath: string
  onPatch: (patch: Partial<EnrichmentDoc>) => void
  onOpenIntelDb: () => void
  onNewIntelDb: () => void
  /** Pivot selected indicators into a workspace sweep (target chosen in App). */
  onSweep: (values: string[]) => void
}): JSX.Element {
  const [providers, setProviders] = useState<EnrichProviderInfo[]>([])
  const [watchlistsOpen, setWatchlistsOpen] = useState(false)
  const [results, setResults] = useState<ResultMap>({})
  const [entryCount, setEntryCount] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number; current: string } | null>(null)
  const reqRef = useRef(0)
  // Provider id of the in-flight run, so streamed progress rows merge into the right bucket.
  const runProviderRef = useRef('')
  const [addNote, setAddNote] = useState<string | null>(null)

  // Resizable paste box (full-width bottom drag bar).
  const [paneH, setPaneH] = useState(56)

  // MaxMind setup state (download GeoLite2 with the user's free license key).
  const [keyDraft, setKeyDraft] = useState('')
  const [hasKey, setHasKey] = useState(false)
  const [setup, setSetup] = useState<{ editionId: string; pct: number } | null>(null)
  const [setupErr, setSetupErr] = useState<string | null>(null)
  const setupBusy = setup !== null

  // VirusTotal key state — the user only pastes a key; main validates it + auto-detects the tier/pace.
  const [vtKeyDraft, setVtKeyDraft] = useState('')
  const [vtHasKey, setVtHasKey] = useState(false)
  const [vtBusy, setVtBusy] = useState(false)
  const [vtErr, setVtErr] = useState<string | null>(null)
  const [vtSettings, setVtSettings] = useState<{ requestsPerMinute: number; dailyQuota: number | null } | null>(null)
  // VirusTotal re-check confirmation (some targets already cached) and run-level (quota) banner.
  const [vtConfirm, setVtConfirm] = useState<{ newItems: EnrichItem[]; cachedItems: EnrichItem[] } | null>(null)
  const [runErr, setRunErr] = useState<string | null>(null)
  // Which already-configured provider's setup card is open for editing (re-key / remove). The cards
  // otherwise only show until the provider is ready, so this re-opens one to change it afterward.
  const [manageProvider, setManageProvider] = useState<string | null>(null)

  const refreshProviders = useCallback(() => {
    void window.api.enrich.providers().then(setProviders)
  }, [])
  useEffect(refreshProviders, [refreshProviders])
  useEffect(() => {
    void window.api.enrich.hasKey().then(setHasKey)
    void window.api.enrich.vtHasKey().then(setVtHasKey)
    void window.api.enrich.vtGetSettings().then(setVtSettings)
  }, [])
  useEffect(() => {
    return window.api.enrich.onSetupProgress((p) => {
      const ev = p as { editionId: string; received: number; total: number }
      setSetup({ editionId: ev.editionId, pct: ev.total > 0 ? Math.round((ev.received / ev.total) * 100) : 0 })
    })
  }, [])
  useEffect(() => {
    return window.api.enrich.onProgress((p) => {
      const ev = p as EnrichProgress
      if (ev.reqId !== reqRef.current) return
      setProgress({ done: ev.done, total: ev.total, current: ev.current })
      // Live render: merge each finished row into its provider bucket as it streams in (the run's
      // final .then still re-merges the full set, idempotently).
      const row = ev.row
      const pid = runProviderRef.current
      if (row && pid) {
        setResults((prev) => ({ ...prev, [row.indicator]: { ...(prev[row.indicator] ?? {}), [pid]: row } }))
      }
    })
  }, [])

  const maxmind = providers.find((p) => p.id === 'maxmind')
  const virustotal = providers.find((p) => p.id === 'virustotal')

  // Look up `items` against one provider, writing to this tab's intel DB and merging results.
  const runLookup = useCallback((providerId: string, items: EnrichItem[]) => {
    if (items.length === 0 || !doc.dbPath) return
    const reqId = ++lookupCounter
    reqRef.current = reqId
    runProviderRef.current = providerId
    setBusy(true)
    setProgress({ done: 0, total: items.length, current: '' })
    window.api.enrich
      .bulk(reqId, doc.dbPath, providerId, items)
      .then((res) => {
        if (reqRef.current !== reqId) return
        // A plain user cancel/supersede discards partial rows; a quota abort keeps what completed and
        // surfaces a banner (so we don't silently drop the work already spent against the quota).
        if (res.canceled && res.aborted !== 'quota') return
        if (res.aborted === 'quota') setRunErr(res.message ?? 'VirusTotal daily quota reached — run stopped early.')
        setResults((prev) => {
          const next: ResultMap = { ...prev }
          for (const row of res.rows) next[row.indicator] = { ...(next[row.indicator] ?? {}), [providerId]: row }
          return next
        })
      })
      .finally(() => {
        if (reqRef.current === reqId) {
          setBusy(false)
          setProgress(null)
          if (doc.dbPath) void window.api.enrich.cacheCount(doc.dbPath).then(setEntryCount)
        }
      })
  }, [doc.dbPath])

  function cancel(): void {
    reqRef.current = 0
    window.api.enrich.cancel()
    setBusy(false)
    setProgress(null)
  }

  // Merge cache-read rows into the matrix (marked fromCache). Never overwrites a row already present
  // (a fresh lookup this session wins over a stale cache read).
  const mergeCacheRows = useCallback((rows: EnrichCachedRow[]) => {
    if (rows.length === 0) return
    setResults((prev) => {
      const next: ResultMap = { ...prev }
      for (const r of rows) {
        const byP = next[r.indicator] ?? {}
        if (byP[r.provider]) continue
        next[r.indicator] = {
          ...byP,
          [r.provider]: { indicator: r.indicator, kind: r.kind, status: r.status, fields: r.fields, fromCache: true, fetchedAt: r.fetchedAt }
        }
      }
      return next
    })
  }, [])


  // Resolve which intel DB this tab uses: a migrated/blank doc binds to the default DB.
  useEffect(() => {
    if (doc.dbPath) return
    void (defaultDbPath ? Promise.resolve(defaultDbPath) : window.api.enrich.defaultDb()).then((p) => {
      if (p) onPatch({ dbPath: p, name: p === defaultDbPath ? 'Global Intel' : p.split(/[\\/]/).pop()?.replace(/\.db$/i, '') || 'intel' })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.dbPath, defaultDbPath])

  // When the bound DB is known/changes: fetch its entry count and load any already-cached values
  // for the persisted indicators (cache read, no lookup).
  useEffect(() => {
    if (!doc.dbPath) return
    void window.api.enrich.cacheCount(doc.dbPath).then((n) => {
      setEntryCount(n)
      // Opening an Intel tab shows its contents automatically — no manual "Load all". Only when the
      // tab has no list yet (a persisted list is hydrated via the cacheGet path below instead).
      if (n > 0 && doc.indicators.length === 0) loadAll(true)
    })
    if (doc.indicators.length > 0) {
      void window.api.enrich.cacheGet(doc.dbPath, doc.indicators.map((i) => i.value)).then(mergeCacheRows)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.dbPath])

  // Add: parse the paste box, classify, append NEW indicators. No lookup (that's explicit). Tokens
  // that don't match any indicator pattern are KEPT in the box (so you can see + fix/remove them
  // rather than have them silently vanish); a note summarizes what happened.
  function addFromDraft(): void {
    const tokens = doc.draft.split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean)
    const have = new Set(doc.indicators.map((i) => i.value))
    const added: EnrichItem[] = []
    const unrecognized: string[] = []
    let dupes = 0
    for (const t of tokens) {
      const kind = classifyIndicator(t)
      if (!kind) {
        if (!unrecognized.includes(t)) unrecognized.push(t)
        continue
      }
      const v = canonicalIndicator(t, kind)
      if (have.has(v)) {
        dupes++
        continue
      }
      have.add(v)
      added.push({ value: v, kind })
    }
    // Recognized + new go to the list; dupes are dropped (already listed); unrecognized stay in the box.
    onPatch({ draft: unrecognized.join('\n'), ...(added.length > 0 ? { indicators: [...doc.indicators, ...added] } : {}) })
    if (added.length > 0 && doc.dbPath) void window.api.enrich.cacheGet(doc.dbPath, added.map((i) => i.value)).then(mergeCacheRows)
    const parts: string[] = []
    if (added.length) parts.push(`added ${added.length}`)
    if (dupes) parts.push(`${dupes} already listed`)
    if (unrecognized.length) parts.push(`${unrecognized.length} not recognized`)
    setAddNote(parts.length ? parts.join(' · ') : null)
  }

  function clearAll(): void {
    onPatch({ indicators: [], draft: '' })
    setResults({})
  }

  // Drop cached results for these indicators (every provider). The rows stay in the list and go
  // blank, so the next Enrich fetches fresh.
  function clearCacheTargets(targets: string[]): void {
    if (doc.dbPath) {
      void window.api.enrich.cacheDelete(doc.dbPath, targets).then(() => {
        void window.api.enrich.cacheCount(doc.dbPath).then(setEntryCount)
      })
    }
    setResults((prev) => {
      const next = { ...prev }
      for (const t of targets) delete next[t]
      return next
    })
  }

  // "Load all": pull every entry in the bound DB into the working list + results (capped). `silent`
  // skips the status note — used by the auto-load on tab open, where the populated grid is feedback enough.
  function loadAll(silent = false): void {
    if (!doc.dbPath) return
    void window.api.enrich.cacheDump(doc.dbPath, LOAD_CAP).then((rows) => {
      const have = new Set(doc.indicators.map((i) => i.value))
      const seen = new Set<string>()
      const add: EnrichItem[] = []
      for (const r of rows) {
        if (have.has(r.indicator) || seen.has(r.indicator)) continue
        seen.add(r.indicator)
        add.push({ value: r.indicator, kind: r.kind as EnrichItem['kind'] })
      }
      if (add.length > 0) onPatch({ indicators: [...doc.indicators, ...add] })
      mergeCacheRows(rows)
      if (!silent)
        setAddNote(
          rows.length >= LOAD_CAP
            ? `loaded first ${LOAD_CAP.toLocaleString()} entries from the database`
            : `loaded ${add.length} from the database`
        )
    })
  }

  function removeTargets(targets: string[]): void {
    const drop = new Set(targets)
    onPatch({ indicators: doc.indicators.filter((i) => !drop.has(i.value)) })
    setResults((prev) => {
      const next = { ...prev }
      for (const t of targets) delete next[t]
      return next
    })
  }

  // --- paste-box resize (drag the bottom bar) ---
  const startResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const startY = e.clientY
      const startH = paneH
      const onMove = (ev: MouseEvent): void => setPaneH(Math.min(400, Math.max(48, startH + (ev.clientY - startY))))
      const onUp = (): void => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [paneH]
  )

  async function pickDb(): Promise<void> {
    const path = await window.api.enrich.pickMmdb()
    if (path) refreshProviders()
  }
  async function runSetup(): Promise<void> {
    setSetupErr(null)
    setSetup({ editionId: '…', pct: 0 })
    const res = await window.api.enrich.maxmindSetup(keyDraft.trim() || undefined)
    setSetup(null)
    if (res.ok) {
      setHasKey(true)
      setKeyDraft('')
      setManageProvider(null)
      refreshProviders()
    } else {
      setSetupErr(res.error)
    }
  }

  async function saveVtKey(): Promise<void> {
    setVtErr(null)
    setVtBusy(true)
    const res = await window.api.enrich.vtSetKey(vtKeyDraft.trim())
    setVtBusy(false)
    if (res.ok) {
      setVtKeyDraft('')
      setVtHasKey(true)
      setManageProvider(null)
      void window.api.enrich.vtGetSettings().then(setVtSettings)
      refreshProviders()
    } else {
      setVtErr(res.error)
    }
  }

  // Remove the stored VirusTotal key (clears the encrypted blob + detected pace in main).
  async function removeVtKey(): Promise<void> {
    setVtErr(null)
    setVtBusy(true)
    await window.api.enrich.vtSetKey('')
    setVtBusy(false)
    setVtKeyDraft('')
    setVtHasKey(false)
    setVtSettings(null)
    setManageProvider(null)
    refreshProviders()
  }

  // Run VirusTotal; on a forced re-check, drop the cached rows first so they're re-fetched.
  function runVt(items: EnrichItem[], forceRecheck: boolean): void {
    if (items.length === 0 || !doc.dbPath) return
    if (forceRecheck) {
      void window.api.enrich.cacheDelete(doc.dbPath, items.map((i) => i.value)).then(() => {
        if (doc.dbPath) void window.api.enrich.cacheCount(doc.dbPath).then(setEntryCount)
        runLookup('virustotal', items)
      })
    } else {
      runLookup('virustotal', items)
    }
  }

  // The grid (IntelGrid) owns sort/filter/selection/reorder UI; this is the run action it calls back.
  function handleRun(providerId: string, values: string[]): void {
    setRunErr(null)
    const items = doc.indicators.filter((i) => values.includes(i.value))
    // VirusTotal never auto-expires, so a re-run would re-spend quota on already-known indicators.
    // Split cached vs new: run only the new ones by default, and require a confirm to force re-checks.
    if (providerId !== 'virustotal' || !doc.dbPath) {
      runLookup(providerId, items)
      return
    }
    void window.api.enrich.cacheGet(doc.dbPath, values).then((rows) => {
      const cached = new Set(rows.filter((r) => r.provider === 'virustotal').map((r) => r.indicator))
      const newItems = items.filter((i) => !cached.has(i.value))
      const cachedItems = items.filter((i) => cached.has(i.value))
      if (cachedItems.length === 0) runLookup('virustotal', newItems)
      else setVtConfirm({ newItems, cachedItems })
    })
  }

  // VirusTotal request estimate: count, share of the (detected) daily quota, and time at the pace.
  function vtEstimate(n: number): string {
    const parts = [`≈ ${n} request${n === 1 ? '' : 's'}`]
    if (vtSettings?.dailyQuota) parts.push(`~${Math.max(1, Math.round((n / vtSettings.dailyQuota) * 100))}% of ${vtSettings.dailyQuota}/day`)
    const rpm = vtSettings?.requestsPerMinute ?? 0
    if (rpm > 0 && n > 0) parts.push(`≈ ${Math.ceil(n / rpm)} min`)
    return parts.join(' · ')
  }

  const pct = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0

  return (
    <div
      className="flex flex-col flex-1 min-w-0 min-h-0 bg-citrus-cream/30 dark:bg-citrus-night"
      style={{ display: visible ? 'flex' : 'none' }}
    >
      {/* Intel DB bar — which database this tab reads/writes, + open/create/load-all. */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-1.5 border-b border-citrus-border dark:border-citrus-night-border">
        <span
          className="inline-flex items-center gap-1.5 text-[11px] text-citrus-dark dark:text-citrus-night-text"
          title={doc.dbPath || 'resolving…'}
        >
          <Database className="w-3.5 h-3.5 text-citrus-pink" />
          <span className="text-citrus-muted dark:text-citrus-night-muted">Intel DB:</span>
          <strong>{doc.name}</strong>
          {entryCount != null && (
            <span className="text-citrus-muted dark:text-citrus-night-muted">· {entryCount.toLocaleString()} entries</span>
          )}
        </span>
        <button
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold border border-citrus-border text-citrus-dark hover:bg-citrus-sand/60 transition-colors dark:border-citrus-night-border dark:text-citrus-night-text dark:hover:bg-citrus-night-elev"
          onClick={onOpenIntelDb}
          title="Open another intel DB in a new tab"
        >
          <FolderOpen className="w-3 h-3" /> Open…
        </button>
        <button
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold border border-citrus-border text-citrus-dark hover:bg-citrus-sand/60 transition-colors dark:border-citrus-night-border dark:text-citrus-night-text dark:hover:bg-citrus-night-elev"
          onClick={onNewIntelDb}
          title="Create a new intel DB in a new tab"
        >
          <FilePlus className="w-3 h-3" /> New…
        </button>
        <button
          className="ml-auto inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold border border-citrus-border text-citrus-dark hover:bg-citrus-sand/60 transition-colors disabled:opacity-40 dark:border-citrus-night-border dark:text-citrus-night-text dark:hover:bg-citrus-night-elev"
          onClick={() => loadAll()}
          disabled={!doc.dbPath || entryCount === 0}
          title="Load all entries"
        >
          <ListTree className="w-3 h-3" /> Load all
        </button>
      </div>

      {/* Providers status strip */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-citrus-border dark:border-citrus-night-border">
        <span className="text-[10px] font-bold uppercase tracking-wide text-citrus-muted dark:text-citrus-night-muted">Providers</span>
        {providers.length === 0 && <span className="text-[11px] text-citrus-muted dark:text-citrus-night-muted">…</span>}
        {providers.map((p) => (
          <span
            key={p.id}
            className="inline-flex items-center gap-1.5 rounded-full border border-citrus-border px-2 py-0.5 text-[11px] dark:border-citrus-night-border"
            title={p.ready ? p.detail : `${p.name} needs configuring`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${p.ready ? 'bg-emerald-500' : 'bg-amber-500'}`} />
            <span className="font-semibold text-citrus-dark dark:text-citrus-night-text">{p.name}</span>
            <span className="text-citrus-muted dark:text-citrus-night-muted">
              ·{' '}
              {!p.ready
                ? 'needs key'
                : p.id === 'virustotal' && vtSettings
                  ? vtSettings.requestsPerMinute > 0
                    ? `${vtSettings.dailyQuota ? 'free' : 'paced'} · ${vtSettings.requestsPerMinute}/min`
                    : 'premium · unthrottled'
                  : p.detail}
            </span>
            {p.ready && p.id === 'maxmind' && (
              <button
                className="ml-0.5 text-citrus-muted hover:text-citrus-pink disabled:opacity-50 dark:text-citrus-night-muted"
                onClick={() => void runSetup()}
                disabled={setupBusy}
                title="Update GeoLite2 data"
              >
                <RefreshCw className={`w-3 h-3 ${setupBusy ? 'animate-spin' : ''}`} />
              </button>
            )}
            {p.ready && (p.id === 'maxmind' || p.id === 'virustotal') && (
              <button
                className={`ml-0.5 hover:text-citrus-pink dark:text-citrus-night-muted ${manageProvider === p.id ? 'text-citrus-pink' : 'text-citrus-muted'}`}
                onClick={() => setManageProvider((m) => (m === p.id ? null : p.id))}
                title={`Edit ${p.name} key`}
              >
                <KeyRound className="w-3 h-3" />
              </button>
            )}
          </span>
        ))}
        <div className="ml-auto flex items-center gap-2">
          <button
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold border border-citrus-border text-citrus-dark hover:bg-citrus-sand/60 transition-colors dark:border-citrus-night-border dark:text-citrus-night-text dark:hover:bg-citrus-night-elev"
            onClick={() => setWatchlistsOpen(true)}
            title="Edit watchlists"
          >
            <ListChecks className="w-3 h-3" /> Watchlists
          </button>
          <span className="text-[11px] font-mono text-citrus-muted dark:text-citrus-night-muted">
            {doc.indicators.length.toLocaleString()} indicators
          </span>
          {busy && (
            <button
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-bold border border-citrus-border text-citrus-muted hover:text-citrus-pink hover:border-citrus-pink/40 transition-colors dark:border-citrus-night-border dark:text-citrus-night-muted"
              onClick={cancel}
            >
              <X className="w-3 h-3" /> Cancel
            </button>
          )}
        </div>
      </div>

      {/* MaxMind setup card — shown until a database is installed, or re-opened via the pill's edit button. */}
      {maxmind && (!maxmind.ready || manageProvider === 'maxmind') && (
        <div className="mx-4 my-2 rounded-lg border border-citrus-border bg-citrus-card px-3 py-2.5 dark:border-citrus-night-border dark:bg-citrus-night-card">
          <div className="flex items-center gap-1.5 text-xs font-bold text-citrus-dark dark:text-citrus-night-text">
            <KeyRound className="w-3.5 h-3.5 text-citrus-pink" /> {maxmind.ready ? 'GeoLite2 settings' : 'Set up GeoLite2 (free)'}
            {manageProvider === 'maxmind' && (
              <button className="ml-auto text-citrus-muted hover:text-citrus-pink dark:text-citrus-night-muted" onClick={() => setManageProvider(null)} title="Close">
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          <p className="mt-1 text-[11px] text-citrus-muted dark:text-citrus-night-muted">
            Free, but needs a one-time license key. Create an account at{' '}
            <span className="font-mono">maxmind.com/geolite2/signup</span>, generate a key, and paste it below.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              type="password"
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
              placeholder={hasKey ? 'Saved — leave blank to reuse' : 'Paste MaxMind license key'}
              className="w-60 px-2 py-1 text-xs rounded border border-citrus-border bg-citrus-cream text-citrus-dark outline-none focus:border-citrus-pink dark:border-citrus-night-border dark:bg-citrus-night dark:text-citrus-night-text"
            />
            <button
              className="inline-flex items-center gap-1 px-3 py-1 rounded-md text-[11px] font-bold bg-citrus-pink text-white hover:bg-citrus-pink-hover transition-colors disabled:opacity-40"
              onClick={() => void runSetup()}
              disabled={setupBusy || (!keyDraft.trim() && !hasKey)}
            >
              {setupBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
              Download GeoLite2
            </button>
            <button
              className="px-2 py-1 rounded text-[11px] font-semibold border border-citrus-border text-citrus-muted hover:text-citrus-pink hover:border-citrus-pink/40 transition-colors dark:border-citrus-night-border dark:text-citrus-night-muted"
              onClick={() => void pickDb()}
              title="Already have a .mmdb?"
            >
              Set .mmdb manually…
            </button>
          </div>
          {setupBusy && (
            <div className="mt-2 flex items-center gap-2 text-[11px] text-citrus-muted dark:text-citrus-night-muted">
              <div className="h-1 w-40 overflow-hidden rounded-full bg-citrus-sand dark:bg-citrus-night-elev">
                <div className="h-full rounded-full bg-citrus-pink transition-[width] duration-150" style={{ width: `${setup?.pct ?? 0}%` }} />
              </div>
              <span className="font-mono truncate">Downloading {setup?.editionId} · {setup?.pct ?? 0}%</span>
            </div>
          )}
          {setupErr && (
            <div className="mt-2 flex items-center gap-1.5 text-[11px] text-red-600 dark:text-red-400">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {setupErr}
            </div>
          )}
        </div>
      )}

      {/* VirusTotal setup card — shown until a key is stored, or re-opened via the pill's edit button. */}
      {virustotal && (!virustotal.ready || manageProvider === 'virustotal') && (
        <div className="mx-4 my-2 rounded-lg border border-citrus-border bg-citrus-card px-3 py-2.5 dark:border-citrus-night-border dark:bg-citrus-night-card">
          <div className="flex items-center gap-1.5 text-xs font-bold text-citrus-dark dark:text-citrus-night-text">
            <KeyRound className="w-3.5 h-3.5 text-citrus-pink" /> {virustotal.ready ? 'VirusTotal key' : 'Connect VirusTotal'}
            {manageProvider === 'virustotal' && (
              <button className="ml-auto text-citrus-muted hover:text-citrus-pink dark:text-citrus-night-muted" onClick={() => setManageProvider(null)} title="Close">
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          <p className="mt-1 text-[11px] text-citrus-muted dark:text-citrus-night-muted">
            Free at <span className="font-mono">virustotal.com</span> → your profile → API key. Stored encrypted on this
            machine; tier and rate are detected automatically.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              type="password"
              value={vtKeyDraft}
              onChange={(e) => setVtKeyDraft(e.target.value)}
              placeholder={vtHasKey ? 'Saved — paste to replace' : 'Paste VirusTotal API key'}
              className="w-72 px-2 py-1 text-xs rounded border border-citrus-border bg-citrus-cream text-citrus-dark outline-none focus:border-citrus-pink dark:border-citrus-night-border dark:bg-citrus-night dark:text-citrus-night-text"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && vtKeyDraft.trim()) void saveVtKey()
              }}
            />
            <button
              className="inline-flex items-center gap-1 px-3 py-1 rounded-md text-[11px] font-bold bg-citrus-pink text-white hover:bg-citrus-pink-hover transition-colors disabled:opacity-40"
              onClick={() => void saveVtKey()}
              disabled={vtBusy || !vtKeyDraft.trim()}
            >
              {vtBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <KeyRound className="w-3 h-3" />}
              Save key
            </button>
            {vtHasKey && (
              <button
                className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-semibold border border-citrus-border text-citrus-muted hover:text-red-600 hover:border-red-500/40 transition-colors disabled:opacity-40 dark:border-citrus-night-border dark:text-citrus-night-muted"
                onClick={() => void removeVtKey()}
                disabled={vtBusy}
                title="Remove the stored VirusTotal key from this machine"
              >
                <Trash2 className="w-3 h-3" /> Remove key
              </button>
            )}
          </div>
          {vtErr && (
            <div className="mt-2 flex items-center gap-1.5 text-[11px] text-red-600 dark:text-red-400">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {vtErr}
            </div>
          )}
        </div>
      )}

      {/* Paste box — drag the bottom bar to resize; scrolls when full. Add only appends to the list. */}
      <div className="flex items-start gap-2 px-4 py-2 border-b border-citrus-border dark:border-citrus-night-border">
        <div className="flex-1 min-w-0 flex flex-col">
          <textarea
            className="pane__text w-full min-w-0 resize-none overflow-auto px-2 py-1 text-xs font-mono rounded-t border border-citrus-border bg-citrus-card text-citrus-dark outline-none focus:border-citrus-pink dark:border-citrus-night-border dark:bg-citrus-night-card dark:text-citrus-night-text"
            style={{ height: paneH }}
            placeholder="Paste IPs / domains / hashes — one per line"
            value={doc.draft}
            onChange={(e) => {
              onPatch({ draft: e.target.value })
              if (addNote) setAddNote(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                addFromDraft()
              }
            }}
          />
          <div
            onMouseDown={startResize}
            className="h-1.5 w-full cursor-row-resize rounded-b border-x border-b border-citrus-border bg-citrus-sand/50 hover:bg-citrus-pink/40 dark:border-citrus-night-border dark:bg-citrus-night-elev"
            title="Drag to resize"
          />
        </div>
        <button
          className="inline-flex items-center gap-1 px-2.5 py-1 mt-0.5 rounded-md text-[11px] font-bold bg-citrus-pink text-white hover:bg-citrus-pink-hover transition-colors disabled:opacity-40"
          onClick={addFromDraft}
          disabled={doc.draft.trim() === ''}
          title="Add to the list"
        >
          <Plus className="w-3 h-3" /> Add
        </button>
        <button
          className="inline-flex items-center gap-1 px-2.5 py-1 mt-0.5 rounded-md text-[11px] font-bold border border-citrus-border text-citrus-muted hover:text-citrus-pink hover:border-citrus-pink/40 transition-colors disabled:opacity-40 dark:border-citrus-night-border dark:text-citrus-night-muted"
          onClick={clearAll}
          disabled={doc.indicators.length === 0 && doc.draft === ''}
        >
          <Trash2 className="w-3 h-3" /> Clear
        </button>
      </div>

      {/* Add summary (e.g. "added 3 · 1 already listed · 2 not recognized — kept in the box") */}
      {addNote && (
        <div className="px-4 py-1 text-[10px] text-citrus-muted dark:text-citrus-night-muted">{addNote}</div>
      )}

      {/* Run-level error (e.g. VirusTotal daily quota exhausted — run stopped). One banner, not per-row. */}
      {runErr && (
        <div className="mx-4 my-1 flex items-center gap-1.5 rounded border border-red-300 bg-red-50 px-2 py-1 text-[11px] text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-300">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span className="flex-1">{runErr}</span>
          <button className="text-red-500 hover:text-red-700 dark:hover:text-red-200" onClick={() => setRunErr(null)} title="Dismiss">
            <X className="w-3 h-3" />
          </button>
        </div>
      )}

      {/* Progress */}
      {busy && progress && (
        <div className="flex items-center gap-2 px-4 py-1.5 text-[11px] text-citrus-muted dark:text-citrus-night-muted">
          <Loader2 className="w-3 h-3 animate-spin text-citrus-pink" />
          <div className="h-1 w-40 overflow-hidden rounded-full bg-citrus-sand dark:bg-citrus-night-elev">
            <div className="h-full rounded-full bg-citrus-pink transition-[width] duration-150" style={{ width: `${pct}%` }} />
          </div>
          <span className="font-mono truncate">
            {progress.done.toLocaleString()}/{progress.total.toLocaleString()} · {progress.current}
          </span>
        </div>
      )}

      <IntelGrid
        indicators={doc.indicators}
        results={results}
        providers={providers}
        providerOrder={doc.providerOrder}
        fieldOrder={doc.fieldOrder}
        savedSizing={doc.colSizing}
        savedVisibility={doc.colVisibility}
        savedSorting={doc.sorting}
        onReorder={(patch) => onPatch(patch)}
        onViewState={(patch) => onPatch(patch)}
        onRun={handleRun}
        onClearCache={clearCacheTargets}
        onRemove={removeTargets}
        onSweep={onSweep}
      />

      <WatchlistsPanel
        open={watchlistsOpen}
        onClose={() => setWatchlistsOpen(false)}
        onChanged={() => void window.api.enrich.providers().then(setProviders)}
      />

      {/* VirusTotal re-check confirm: some targets are already cached (VT never auto-expires). Look up
          only the new ones by default, or force a re-check that re-spends quota on the cached ones. */}
      {vtConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onMouseDown={() => setVtConfirm(null)}>
          <div
            className="w-[26rem] max-w-[90vw] rounded-lg border border-citrus-border bg-citrus-card p-4 shadow-xl dark:border-citrus-night-border dark:bg-citrus-night-card"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-1.5 text-sm font-bold text-citrus-dark dark:text-citrus-night-text">
              <AlertTriangle className="w-4 h-4 text-citrus-pink" /> VirusTotal re-check
            </div>
            <p className="mt-2 text-[12px] text-citrus-muted dark:text-citrus-night-muted">
              <strong className="text-citrus-dark dark:text-citrus-night-text">{vtConfirm.cachedItems.length}</strong> of these are
              already cached and <strong className="text-citrus-dark dark:text-citrus-night-text">{vtConfirm.newItems.length}</strong>{' '}
              {vtConfirm.newItems.length === 1 ? 'is' : 'are'} new. VirusTotal results don't expire, so re-checking the cached ones
              re-spends your quota.
            </p>
            <div className="mt-3 flex flex-col gap-2">
              <button
                className="inline-flex items-center justify-center gap-1 px-3 py-1.5 rounded-md text-[12px] font-bold bg-citrus-pink text-white hover:bg-citrus-pink-hover transition-colors disabled:opacity-40"
                disabled={vtConfirm.newItems.length === 0}
                onClick={() => {
                  runLookup('virustotal', vtConfirm.newItems)
                  setVtConfirm(null)
                }}
                title={vtConfirm.newItems.length === 0 ? 'Nothing new to look up' : undefined}
              >
                Look up {vtConfirm.newItems.length} new ({vtEstimate(vtConfirm.newItems.length)})
              </button>
              <button
                className="inline-flex items-center justify-center gap-1 px-3 py-1.5 rounded-md text-[12px] font-bold border border-red-300 text-red-700 hover:bg-red-50 transition-colors dark:border-red-900/50 dark:text-red-300 dark:hover:bg-red-900/20"
                onClick={() => {
                  runVt([...vtConfirm.newItems, ...vtConfirm.cachedItems], true)
                  setVtConfirm(null)
                }}
              >
                Force re-check all {vtConfirm.newItems.length + vtConfirm.cachedItems.length} (
                {vtEstimate(vtConfirm.newItems.length + vtConfirm.cachedItems.length)})
              </button>
              <button
                className="px-3 py-1 rounded-md text-[12px] font-semibold text-citrus-muted hover:text-citrus-pink dark:text-citrus-night-muted"
                onClick={() => setVtConfirm(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
