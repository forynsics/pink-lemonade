import { useMemo, useState } from 'react'
import { Search, X } from 'lucide-react'
import { getAll } from '../tools/registry'
import { toolIcon } from './toolIcons'
import type { Tool, ToolCategory } from '../tools/types'

const CATEGORY_LABELS: Record<ToolCategory, string> = {
  text: 'Text',
  ioc: 'IOC',
  query: 'Query'
}

const CATEGORY_BADGE: Record<ToolCategory, string> = {
  text: 'bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-300',
  ioc: 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-300',
  query: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-300'
}

export function ToolPalette({ onPick }: { onPick: (id: string) => void }): JSX.Element {
  const [query, setQuery] = useState('')
  const [cat, setCat] = useState<ToolCategory | 'all'>('all')
  const tools = getAll()

  const categories = useMemo(() => {
    const present = new Set<ToolCategory>(tools.map((t) => t.category))
    return (['text', 'ioc', 'query'] as ToolCategory[]).filter((c) => present.has(c))
  }, [tools])

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = tools.filter(
      (t) =>
        (cat === 'all' || t.category === cat) &&
        (!q ||
          t.name.toLowerCase().includes(q) ||
          t.description.toLowerCase().includes(q) ||
          t.category.includes(q))
    )
    const map = new Map<ToolCategory, Tool[]>()
    for (const t of filtered) {
      const arr = map.get(t.category) ?? []
      arr.push(t)
      map.set(t.category, arr)
    }
    return [...map.entries()]
  }, [query, cat, tools])

  const empty = grouped.length === 0

  return (
    <aside className="palette w-72 flex-shrink-0 flex flex-col min-h-0 border-r border-citrus-border bg-citrus-sand/40 dark:border-citrus-night-border dark:bg-citrus-night">
      {/* Search + category chips */}
      <div className="p-3 border-b border-citrus-border/60 dark:border-citrus-night-border/60">
        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-citrus-muted dark:text-citrus-night-muted" />
          <input
            className="w-full pl-8 pr-7 py-1.5 rounded-lg text-xs bg-citrus-card border border-citrus-border outline-none focus:border-citrus-pink transition-colors text-citrus-dark dark:bg-citrus-night-card dark:border-citrus-night-border dark:text-citrus-night-text"
            placeholder="Search tools…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
          />
          {query && (
            <button
              className="absolute right-2.5 top-2 text-citrus-muted hover:text-citrus-dark dark:text-citrus-night-muted"
              onClick={() => setQuery('')}
              title="Clear search"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        <div className="grid grid-cols-4 gap-1 mt-2.5">
          {(['all', ...categories] as const).map((c) => (
            <button
              key={c}
              onClick={() => setCat(c)}
              className={`text-[10px] py-1 rounded font-bold uppercase tracking-tight border transition-colors ${
                cat === c
                  ? 'bg-citrus-pink text-white border-citrus-pink'
                  : 'bg-citrus-card text-citrus-muted border-citrus-border/60 hover:text-citrus-dark dark:bg-citrus-night-card dark:text-citrus-night-muted dark:border-citrus-night-border'
              }`}
            >
              {c === 'all' ? 'All' : CATEGORY_LABELS[c]}
            </button>
          ))}
        </div>
      </div>

      {/* Tool list */}
      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {grouped.map(([category, list]) => (
          <div key={category} className="space-y-1">
            <div className="px-1 pt-1 text-[10px] font-bold uppercase tracking-wider text-citrus-muted dark:text-citrus-night-muted">
              {CATEGORY_LABELS[category]}
            </div>
            {list.map((t) => {
              const Icon = toolIcon(t.id, t.category)
              return (
                <button
                  key={t.id}
                  className="palette__item group w-full text-left p-2 rounded-lg border border-citrus-border/60 bg-citrus-card hover:border-citrus-pink/40 hover:bg-citrus-pink-light/40 transition-colors flex items-start gap-2.5 dark:bg-citrus-night-card dark:border-citrus-night-border dark:hover:bg-citrus-night-elev"
                  onClick={() => onPick(t.id)}
                  title={t.description}
                >
                  <span className="p-1 rounded bg-citrus-cream border border-citrus-border group-hover:bg-citrus-pink-light group-hover:border-citrus-pink/30 transition-colors dark:bg-citrus-night dark:border-citrus-night-border">
                    <Icon className="w-4 h-4 text-citrus-pink" />
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="flex items-center justify-between gap-2">
                      <span className="font-bold text-xs truncate text-citrus-dark group-hover:text-citrus-pink transition-colors dark:text-citrus-night-text">
                        {t.name}
                      </span>
                      <span
                        className={`text-[8px] font-extrabold px-1 py-px rounded ${CATEGORY_BADGE[t.category]}`}
                      >
                        {CATEGORY_LABELS[t.category].toUpperCase()}
                      </span>
                    </span>
                    <span className="block text-[10px] leading-tight mt-0.5 text-citrus-muted line-clamp-2 dark:text-citrus-night-muted">
                      {t.description}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        ))}
        {empty && (
          <div className="p-4 text-center text-xs text-citrus-muted dark:text-citrus-night-muted">
            No tools match “{query}”.
          </div>
        )}
      </div>
    </aside>
  )
}
