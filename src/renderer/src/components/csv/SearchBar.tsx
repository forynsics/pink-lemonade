import { ChevronDown, ChevronUp, Loader2, Search, X } from 'lucide-react'

// Global quick-find for a CSV tab: one term matched against every column. The input is
// controlled by the parent (which debounces it before it drives the query) so typing stays
// snappy even on a multi-million-row table. Enter steps to the next matching row (Shift+Enter
// the previous); the count shows "k / N" once you start stepping.

export function SearchBar({
  value,
  active,
  matches,
  position,
  loading,
  onChange,
  onClear,
  onStep
}: {
  value: string
  /** true once the debounced term is actually applied to the query */
  active: boolean
  /** matching row count for the applied term (only meaningful when `active`) */
  matches: number
  /** 1-based index of the currently-focused match, or 0 before any stepping */
  position: number
  loading: boolean
  onChange: (v: string) => void
  onClear: () => void
  /** Step to the next (+1) / previous (-1) match. */
  onStep: (dir: 1 | -1) => void
}): JSX.Element {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 border-b border-citrus-border/60 bg-citrus-cream/60 dark:border-citrus-night-border/60 dark:bg-citrus-night">
      <div className="relative flex-1 max-w-md">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-citrus-muted dark:text-citrus-night-muted" />
        <input
          className="csv-search w-full pl-7 pr-7 py-1 text-xs rounded-md border border-citrus-border bg-citrus-card text-citrus-dark outline-none focus:border-citrus-pink dark:border-citrus-night-border dark:bg-citrus-night-card dark:text-citrus-night-text"
          value={value}
          placeholder="Search all columns…"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClear()
            else if (e.key === 'Enter') {
              e.preventDefault()
              onStep(e.shiftKey ? -1 : 1)
            }
          }}
          spellCheck={false}
        />
        {value !== '' && (
          <button
            onClick={onClear}
            title="Clear search (Esc)"
            className="absolute right-1.5 top-1/2 -translate-y-1/2 text-citrus-muted hover:text-citrus-pink"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      {loading ? (
        <Loader2 className="w-3.5 h-3.5 animate-spin text-citrus-pink" />
      ) : (
        active && (
          <div className="flex items-center gap-1.5 whitespace-nowrap">
            <span className="text-[11px] font-mono text-citrus-muted dark:text-citrus-night-muted">
              {position > 0
                ? `${position.toLocaleString()} / ${matches.toLocaleString()}`
                : `${matches.toLocaleString()} ${matches === 1 ? 'match' : 'matches'}`}
            </span>
            {matches > 0 && (
              <>
                <button
                  onClick={() => onStep(-1)}
                  title="Previous match (Shift+Enter)"
                  className="text-citrus-muted hover:text-citrus-pink dark:text-citrus-night-muted"
                >
                  <ChevronUp className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => onStep(1)}
                  title="Next match (Enter)"
                  className="text-citrus-muted hover:text-citrus-pink dark:text-citrus-night-muted"
                >
                  <ChevronDown className="w-3.5 h-3.5" />
                </button>
              </>
            )}
          </div>
        )
      )}
    </div>
  )
}
