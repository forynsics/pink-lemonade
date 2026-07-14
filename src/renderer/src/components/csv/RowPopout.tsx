import { useEffect, useState } from 'react'
import { Check, Copy, X } from 'lucide-react'

// A centered modal listing every column of one row as label/value pairs, so the whole record is
// readable at once without scrolling the grid horizontally to the last column. Mirrors CellPopout
// (Esc to close, one-click copy) but for the full row. Values are selectable; "Copy all" yields one
// `field<TAB>value` line per column.

export interface RowField {
  label: string
  value: string
}

export function RowPopout({
  title,
  fields,
  onClose
}: {
  title: string
  fields: RowField[]
  onClose: () => void
}): JSX.Element {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function copyAll(): Promise<void> {
    try {
      await navigator.clipboard.writeText(fields.map((f) => `${f.label}\t${f.value}`).join('\n'))
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
        className="row-popout flex flex-col w-[min(680px,92vw)] max-h-[80vh] rounded-xl border border-citrus-border bg-citrus-card shadow-lg dark:border-citrus-night-border dark:bg-citrus-night-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-citrus-border dark:border-citrus-night-border">
          <span className="text-xs font-bold text-citrus-dark truncate dark:text-citrus-night-text">
            {title} · {fields.length} fields
          </span>
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={copyAll}
              title="Copy all fields"
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-bold text-citrus-pink hover:bg-citrus-pink-light dark:hover:bg-citrus-night-elev"
            >
              {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              {copied ? 'Copied' : 'Copy all'}
            </button>
            <button onClick={onClose} title="Close (Esc)" className="text-citrus-muted hover:text-citrus-pink">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
        <div className="overflow-auto p-1.5">
          <table className="w-full border-collapse">
            <tbody>
              {fields.map((f, i) => (
                <tr
                  key={i}
                  className="align-top border-b border-citrus-border/30 last:border-0 dark:border-citrus-night-border/30"
                >
                  <td className="w-[34%] px-2.5 py-1.5 text-[11px] font-bold uppercase tracking-wide text-citrus-muted break-words dark:text-citrus-night-muted">
                    {f.label}
                  </td>
                  <td className="px-2.5 py-1.5 font-mono text-xs text-citrus-dark break-words whitespace-pre-wrap select-text dark:text-citrus-night-text">
                    {f.value === '' ? '∅ (empty)' : f.value}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
