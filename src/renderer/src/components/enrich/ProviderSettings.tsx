import { useEffect, useState } from 'react'
import { ExternalLink, KeyRound, Loader2, X, Check, Download, FolderOpen } from 'lucide-react'
import type { EnrichProviderInfo, ProviderKeySpec } from '../../state/enrichTypes'

// The one place credentials are entered. Every provider gets a row in a single scrolling list, so a
// new provider shows up here as soon as it declares a key spec in the main process — nothing about
// this component is per-provider except MaxMind's database setup, which is genuinely special (a
// download + a local file rather than a key used at lookup).
//
// Security: keys are WRITE-ONLY from here. There is no API to read one back — a saved key renders as
// "Saved", never as its value — and main refuses to store anything if OS secure storage is
// unavailable rather than falling back to plaintext.

/** MaxMind's extra controls: download the GeoLite2 db, or point at an .mmdb you already have. */
function MaxmindSetup({
  onSetup,
  onPick,
  busy,
  progress
}: {
  onSetup: () => void
  onPick: () => void
  busy: boolean
  progress: string | null
}): JSX.Element {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <button
        onClick={onSetup}
        disabled={busy}
        className="inline-flex items-center gap-1.5 rounded-md border border-citrus-pink/40 bg-citrus-pink/5 px-2.5 py-1 text-[11px] font-bold text-citrus-pink hover:bg-citrus-pink/10 disabled:opacity-60 dark:bg-citrus-pink/10"
      >
        {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
        Download GeoLite2
      </button>
      <button
        onClick={onPick}
        disabled={busy}
        className="inline-flex items-center gap-1.5 rounded-md border border-citrus-border px-2.5 py-1 text-[11px] font-semibold text-citrus-muted hover:border-citrus-pink/40 hover:text-citrus-pink disabled:opacity-60 dark:border-citrus-night-border dark:text-citrus-night-muted"
      >
        <FolderOpen className="w-3 h-3" /> Use an existing .mmdb…
      </button>
      {progress && <span className="text-[11px] text-citrus-muted dark:text-citrus-night-muted">{progress}</span>}
    </div>
  )
}

function ProviderRow({
  provider,
  spec,
  hasKey,
  detail,
  children,
  onSave,
  onClear
}: {
  provider: EnrichProviderInfo
  spec: ProviderKeySpec | undefined
  hasKey: boolean
  detail: string
  children?: JSX.Element
  onSave: (key: string) => Promise<string | null>
  onClear: () => Promise<void>
}): JSX.Element {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function save(): Promise<void> {
    if (!draft.trim()) return
    setBusy(true)
    setErr(null)
    const e = await onSave(draft.trim())
    setBusy(false)
    if (e) setErr(e)
    else setDraft('')
  }

  return (
    <div className="border-b border-citrus-border px-4 py-3 last:border-b-0 dark:border-citrus-night-border">
      <div className="flex items-center gap-2">
        <span className={`w-1.5 h-1.5 shrink-0 rounded-full ${provider.ready ? 'bg-emerald-500' : 'bg-amber-500'}`} />
        <span className="text-xs font-bold text-citrus-dark dark:text-citrus-night-text">{provider.name}</span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-citrus-muted dark:text-citrus-night-muted">{detail}</span>
        {spec?.signupUrl && (
          <button
            onClick={() => void window.api.enrich.openExternal(spec.signupUrl as string)}
            className="inline-flex shrink-0 items-center gap-1 text-[11px] text-citrus-muted hover:text-citrus-pink dark:text-citrus-night-muted"
          >
            Get a key <ExternalLink className="w-3 h-3" />
          </button>
        )}
      </div>

      {spec && (
        <>
          <div className="mt-2 flex items-center gap-2">
            <input
              type="password"
              className="min-w-0 flex-1 rounded-md border border-citrus-border bg-citrus-card px-2 py-1.5 font-mono text-[12px] text-citrus-dark dark:border-citrus-night-border dark:bg-citrus-night-card dark:text-citrus-night-text"
              placeholder={hasKey ? 'Saved — paste to replace' : `Paste ${spec.label.toLowerCase()}`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void save()
              }}
            />
            <button
              onClick={() => void save()}
              disabled={busy || !draft.trim()}
              className="inline-flex shrink-0 items-center gap-1 rounded-md border border-citrus-border px-2.5 py-1.5 text-[11px] font-bold text-citrus-dark hover:bg-citrus-sand/60 disabled:opacity-50 dark:border-citrus-night-border dark:text-citrus-night-text dark:hover:bg-citrus-night-elev"
            >
              {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} Save
            </button>
            {hasKey && (
              <button
                onClick={() => void onClear()}
                className="shrink-0 rounded-md border border-citrus-border px-2.5 py-1.5 text-[11px] font-semibold text-citrus-muted hover:border-citrus-pink/40 hover:text-citrus-pink dark:border-citrus-night-border dark:text-citrus-night-muted"
              >
                Remove
              </button>
            )}
          </div>
          <div className="mt-1 text-[11px] text-citrus-muted dark:text-citrus-night-muted">{spec.help}</div>
          {err && <div className="mt-1 text-[11px] text-red-500">{err}</div>}
        </>
      )}

      {children}
    </div>
  )
}

export function ProviderSettings({
  open,
  onClose,
  providers,
  vtDetail,
  onChanged,
  onMaxmindSetup,
  onPickMmdb,
  setupBusy,
  setupProgress
}: {
  open: boolean
  onClose: () => void
  providers: EnrichProviderInfo[]
  /** The pace/tier line for VirusTotal, computed by the view that owns that state. */
  vtDetail: string | null
  /** Refresh provider readiness after a key changes. */
  onChanged: () => Promise<void>
  onMaxmindSetup: () => void
  onPickMmdb: () => void
  setupBusy: boolean
  setupProgress: string | null
}): JSX.Element | null {
  const [specs, setSpecs] = useState<Record<string, ProviderKeySpec>>({})
  const [status, setStatus] = useState<Record<string, boolean>>({})

  const refresh = async (): Promise<void> => {
    setStatus(await window.api.enrich.keyStatus())
  }

  useEffect(() => {
    if (!open) return
    void window.api.enrich.keySpecs().then(setSpecs)
    void refresh()
  }, [open])

  if (!open) return null

  const save = async (id: string, key: string): Promise<string | null> => {
    const res = await window.api.enrich.setProviderKey(id, key)
    await refresh()
    await onChanged()
    return res.ok ? null : res.error
  }
  const clear = async (id: string): Promise<void> => {
    await window.api.enrich.setProviderKey(id, '')
    await refresh()
    await onChanged()
  }

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/30 p-6" onClick={onClose}>
      <div
        className="flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-xl border border-citrus-border bg-citrus-cream shadow-xl dark:border-citrus-night-border dark:bg-citrus-night"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-citrus-border px-4 py-2.5 dark:border-citrus-night-border">
          <KeyRound className="w-3.5 h-3.5 text-citrus-pink" />
          <span className="flex-1 text-xs font-bold text-citrus-dark dark:text-citrus-night-text">Providers</span>
          <button onClick={onClose} className="text-citrus-muted hover:text-citrus-pink dark:text-citrus-night-muted" title="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {providers.map((p) => (
            <ProviderRow
              key={p.id}
              provider={p}
              spec={specs[p.id]}
              hasKey={!!status[p.id]}
              detail={p.id === 'virustotal' && p.ready && vtDetail ? vtDetail : p.detail}
              onSave={(k) => save(p.id, k)}
              onClear={() => clear(p.id)}
            >
              {p.id === 'maxmind' ? (
                <MaxmindSetup onSetup={onMaxmindSetup} onPick={onPickMmdb} busy={setupBusy} progress={setupProgress} />
              ) : undefined}
            </ProviderRow>
          ))}
        </div>

        <div className="shrink-0 border-t border-citrus-border px-4 py-2 text-[11px] text-citrus-muted dark:border-citrus-night-border dark:text-citrus-night-muted">
          Keys are encrypted by your OS keychain and never leave this machine except to the provider you enable.
        </div>
      </div>
    </div>
  )
}
