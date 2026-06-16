import { useMemo, useState } from 'react'
import { Check, Columns3, Eye } from 'lucide-react'
import type { CsvColumn } from '../../state/csvTypes'

// Toolbar dropdown to show/hide grid columns. Hiding is a pure display concern — the query still
// selects every `c<n>`, so toggling is instant and reversible. Keeps at least one column visible
// (you can't hide the whole grid). Order mirrors the grid's current (reorderable) column order.

export function ColumnPicker({
  columns,
  hidden,
  onToggle,
  onShowAll
}: {
  columns: CsvColumn[]
  hidden: Set<string>
  onToggle: (name: string) => void
  onShowAll: () => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [needle, setNeedle] = useState('')
  const hiddenCount = hidden.size
  const visibleCount = columns.length - hiddenCount

  const shown = useMemo(() => {
    const n = needle.trim().toLowerCase()
    return n === '' ? columns : columns.filter((c) => c.original.toLowerCase().includes(n))
  }, [columns, needle])

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-semibold transition-colors ${
          hiddenCount > 0 || open
            ? 'border-citrus-pink/50 bg-citrus-pink/10 text-citrus-pink'
            : 'border-citrus-border text-citrus-dark hover:border-citrus-pink/40 hover:text-citrus-pink dark:border-citrus-night-border dark:text-citrus-night-text'
        }`}
        title="Show or hide columns"
      >
        <Columns3 className="w-3.5 h-3.5" />
        Columns
        {hiddenCount > 0 && <span className="text-[10px] font-mono">· {hiddenCount} hidden</span>}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-50 mt-1 flex w-60 flex-col rounded-lg border border-citrus-border bg-citrus-card shadow-lg dark:border-citrus-night-border dark:bg-citrus-night-card">
            <div className="flex items-center gap-2 border-b border-citrus-border/60 px-3 py-1.5 dark:border-citrus-night-border/60">
              <span className="text-[10px] font-bold uppercase tracking-wide text-citrus-muted dark:text-citrus-night-muted">
                {visibleCount} of {columns.length} shown
              </span>
              {hiddenCount > 0 && (
                <button
                  onClick={onShowAll}
                  className="ml-auto inline-flex items-center gap-1 text-[11px] font-semibold text-citrus-pink hover:text-citrus-pink-hover"
                  title="Show every column"
                >
                  <Eye className="w-3 h-3" /> Show all
                </button>
              )}
            </div>
            {columns.length > 8 && (
              <input
                autoFocus
                value={needle}
                onChange={(e) => setNeedle(e.target.value)}
                placeholder="find a column…"
                className="mx-2 my-1.5 rounded border border-citrus-border bg-citrus-cream px-2 py-1 text-[11px] text-citrus-dark outline-none focus:border-citrus-pink dark:border-citrus-night-border dark:bg-citrus-night dark:text-citrus-night-text"
              />
            )}
            <div className="max-h-72 overflow-auto scrollbar-none py-1">
              {shown.map((c) => {
                const visible = !hidden.has(c.name)
                // Don't let the user hide the last visible column — the grid needs at least one.
                const isLastVisible = visible && visibleCount <= 1
                return (
                  <button
                    key={c.name}
                    disabled={isLastVisible}
                    onClick={() => onToggle(c.name)}
                    className="flex w-full items-center gap-2 px-3 py-1 text-left text-[11px] hover:bg-citrus-pink-light/50 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-citrus-night-elev"
                    title={isLastVisible ? 'At least one column must stay visible' : visible ? 'Hide this column' : 'Show this column'}
                  >
                    <span
                      className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border ${
                        visible ? 'border-citrus-pink bg-citrus-pink text-white' : 'border-citrus-border dark:border-citrus-night-border'
                      }`}
                    >
                      {visible && <Check className="h-2.5 w-2.5" />}
                    </span>
                    <span
                      className={`truncate ${
                        visible
                          ? 'text-citrus-dark dark:text-citrus-night-text'
                          : 'text-citrus-muted dark:text-citrus-night-muted'
                      }`}
                    >
                      {c.original}
                    </span>
                  </button>
                )
              })}
              {shown.length === 0 && (
                <div className="px-3 py-2 text-[11px] text-citrus-muted dark:text-citrus-night-muted">no columns</div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
