import { useEffect, useState } from 'react'
import { Check, Copy, FolderOpen, Loader2, TerminalSquare, X } from 'lucide-react'
import type { McpStatus } from '../../state/enrichTypes'

// The "drive from a terminal" setup surface. The app hosts a localhost MCP server; this panel writes
// the working folder (.mcp.json + CLAUDE.md + pre-approved perms) and tells the analyst the one thing
// left to do: `cd` there and run `claude`. Everything the terminal does then lands in the app's
// review panels live. No secrets are shown beyond the localhost bearer token embedded in .mcp.json.

function CopyButton({ text }: { text: string }): JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={() => {
        void navigator.clipboard.writeText(text)
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1200)
      }}
      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-citrus-border px-2 py-1 text-[11px] font-semibold text-citrus-muted hover:border-citrus-pink/40 hover:text-citrus-pink dark:border-citrus-night-border dark:text-citrus-night-muted"
      title="Copy"
    >
      {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

export function ConnectPanel({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element | null {
  const [status, setStatus] = useState<McpStatus | null>(null)
  const [dir, setDir] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let alive = true
    const tick = (): void => {
      void window.api.mcp.status().then((s) => {
        if (alive) setStatus(s)
      })
    }
    tick()
    const id = window.setInterval(tick, 3000)
    void window.api.mcp.defaultFolder().then((d) => setDir((cur) => cur ?? d))
    return () => {
      alive = false
      window.clearInterval(id)
    }
  }, [open])

  if (!open) return null

  const setup = async (pick: boolean): Promise<void> => {
    setBusy(true)
    setErr(null)
    try {
      let target = dir ?? undefined
      if (pick) {
        const chosen = await window.api.mcp.pickFolder()
        if (!chosen) {
          setBusy(false)
          return
        }
        target = chosen
      }
      const res = await window.api.mcp.setupFolder(target)
      setDir(res.dir)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const running = !!status?.running
  const cdCmd = dir ? `cd "${dir}"` : ''

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/30 p-6" onClick={onClose}>
      <div
        className="flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-xl border border-citrus-border bg-citrus-cream shadow-xl dark:border-citrus-night-border dark:bg-citrus-night"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-citrus-border px-4 py-2.5 dark:border-citrus-night-border">
          <TerminalSquare className="w-3.5 h-3.5 text-citrus-pink" />
          <span className="flex-1 text-xs font-bold text-citrus-dark dark:text-citrus-night-text">Drive from a terminal</span>
          <button onClick={onClose} className="text-citrus-muted hover:text-citrus-pink dark:text-citrus-night-muted" title="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-auto px-4 py-4 text-xs text-citrus-dark dark:text-citrus-night-text">
          <p className="text-citrus-muted dark:text-citrus-night-muted">
            Run an investigation from your own Claude Code. It connects to this app and works the open workspace — everything it
            records shows up live in the Constellation, Timeline, IOC, and Investigation panels.
          </p>

          <div className="flex items-center gap-2">
            <span className={`w-1.5 h-1.5 shrink-0 rounded-full ${running ? 'bg-emerald-500' : status?.error ? 'bg-red-500' : 'bg-amber-500'}`} />
            <span className={`text-[11px] ${status?.error ? 'text-red-500' : 'text-citrus-muted dark:text-citrus-night-muted'}`}>
              {running ? `Server running · ${status?.url}` : status?.error ? status.error : 'Starting the local server…'}
            </span>
          </div>

          <div>
            <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-citrus-muted dark:text-citrus-night-muted">
              1 · Set up your terminal folder
            </div>
            <div className="mb-2 truncate rounded-md border border-citrus-border bg-citrus-card px-2 py-1.5 font-mono text-[11px] text-citrus-muted dark:border-citrus-night-border dark:bg-citrus-night-card dark:text-citrus-night-muted">
              {dir ?? '…'}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => void setup(false)}
                disabled={busy || !running}
                className="inline-flex items-center gap-1.5 rounded-md border border-citrus-pink/40 bg-citrus-pink/5 px-2.5 py-1 text-[11px] font-bold text-citrus-pink hover:bg-citrus-pink/10 disabled:opacity-60 dark:bg-citrus-pink/10"
              >
                {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                Set up here
              </button>
              <button
                onClick={() => void setup(true)}
                disabled={busy || !running}
                className="inline-flex items-center gap-1.5 rounded-md border border-citrus-border px-2.5 py-1 text-[11px] font-semibold text-citrus-muted hover:border-citrus-pink/40 hover:text-citrus-pink disabled:opacity-60 dark:border-citrus-night-border dark:text-citrus-night-muted"
              >
                <FolderOpen className="w-3 h-3" /> Choose folder…
              </button>
              {dir && (
                <button
                  onClick={() => void window.api.mcp.openFolder(dir)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-citrus-border px-2.5 py-1 text-[11px] font-semibold text-citrus-muted hover:border-citrus-pink/40 hover:text-citrus-pink dark:border-citrus-night-border dark:text-citrus-night-muted"
                >
                  <FolderOpen className="w-3 h-3" /> Open folder
                </button>
              )}
            </div>
            {err && <div className="mt-1.5 text-[11px] text-red-500">{err}</div>}
          </div>

          <div>
            <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-citrus-muted dark:text-citrus-night-muted">
              2 · Run Claude Code there
            </div>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md border border-citrus-border bg-citrus-card px-2 py-1.5 font-mono text-[11px] text-citrus-dark dark:border-citrus-night-border dark:bg-citrus-night-card dark:text-citrus-night-text">
                {cdCmd ? `${cdCmd} && claude` : 'set up a folder first'}
              </code>
              {cdCmd && <CopyButton text={`${cdCmd} && claude`} />}
            </div>
            <p className="mt-1.5 text-[11px] text-citrus-muted dark:text-citrus-night-muted">
              The first time, Claude Code asks you to trust the folder — accept it so the <code>pinklemonade</code> tools connect.
              Then just ask it to investigate; keep this app open while you work.
            </p>
          </div>
        </div>

        <div className="shrink-0 border-t border-citrus-border px-4 py-2 text-[11px] text-citrus-muted dark:border-citrus-night-border dark:text-citrus-night-muted">
          The server listens only on your machine (127.0.0.1), behind a token in the folder’s .mcp.json.
        </div>
      </div>
    </div>
  )
}
