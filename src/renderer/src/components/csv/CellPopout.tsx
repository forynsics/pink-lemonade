import { useEffect, useMemo, useState } from 'react'
import { Check, Copy, X } from 'lucide-react'
import { JsonView } from './JsonView'

// A small centered modal showing one cell's full (untruncated) value, so a wide field is
// readable without resizing the column. The text is selectable and one-click copyable.

export function CellPopout({
  label,
  value,
  onClose
}: {
  label: string
  value: string
  onClose: () => void
}): JSX.Element {
  const [copied, setCopied] = useState(false)

  // Detect a JSON value (object/array that parses) → offer a Pretty tree view. Common for O365
  // audit logs / Hayabusa details, where the real content lives inside one JSON column.
  const parsed = useMemo(() => {
    const s = value.trim()
    if (s[0] !== '{' && s[0] !== '[') return undefined
    try {
      return JSON.parse(s) as unknown
    } catch {
      return undefined
    }
  }, [value])
  const [pretty, setPretty] = useState(true)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      /* clipboard blocked — non-fatal */
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/25"
      onClick={onClose}
    >
      <div
        className="cell-popout flex flex-col w-[min(560px,90vw)] max-h-[70vh] rounded-xl border border-citrus-border bg-citrus-card shadow-lg dark:border-citrus-night-border dark:bg-citrus-night-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-citrus-border dark:border-citrus-night-border">
          <span className="text-xs font-bold text-citrus-dark truncate dark:text-citrus-night-text">{label}</span>
          <div className="flex items-center gap-1 shrink-0">
            {parsed !== undefined && (
              <div className="flex items-center rounded-md border border-citrus-border p-0.5 dark:border-citrus-night-border">
                {(['Pretty', 'Raw'] as const).map((m) => {
                  const on = (m === 'Pretty') === pretty
                  return (
                    <button
                      key={m}
                      onClick={() => setPretty(m === 'Pretty')}
                      className={`px-2 py-0.5 rounded text-[11px] font-bold ${
                        on
                          ? 'bg-citrus-pink text-white'
                          : 'text-citrus-muted hover:text-citrus-pink dark:text-citrus-night-muted'
                      }`}
                    >
                      {m}
                    </button>
                  )
                })}
              </div>
            )}
            <button
              onClick={copy}
              title="Copy value"
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-bold text-citrus-pink hover:bg-citrus-pink-light dark:hover:bg-citrus-night-elev"
            >
              {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button onClick={onClose} title="Close (Esc)" className="text-citrus-muted hover:text-citrus-pink">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
        <div className="overflow-auto p-4">
          {parsed !== undefined && pretty ? (
            <JsonView data={parsed} />
          ) : (
            <pre className="whitespace-pre-wrap break-words font-mono text-xs text-citrus-dark dark:text-citrus-night-text select-text">
              {value === '' ? '∅ (empty)' : value}
            </pre>
          )}
        </div>
      </div>
    </div>
  )
}
