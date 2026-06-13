import { useMemo, useState } from 'react'
import { getAll } from '../tools/registry'
import type { Tool, ToolCategory } from '../tools/types'

const CATEGORY_LABELS: Record<ToolCategory, string> = {
  text: 'Text',
  ioc: 'IOC Extract',
  query: 'Query',
  enrich: 'Enrich'
}

export function ToolPalette({ onPick }: { onPick: (id: string) => void }): JSX.Element {
  const [query, setQuery] = useState('')
  const tools = getAll()

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = tools.filter(
      (t) =>
        !q ||
        t.name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        t.category.includes(q)
    )
    const map = new Map<ToolCategory, Tool[]>()
    for (const t of filtered) {
      const arr = map.get(t.category) ?? []
      arr.push(t)
      map.set(t.category, arr)
    }
    return [...map.entries()]
  }, [query, tools])

  const empty = grouped.length === 0

  return (
    <aside className="palette">
      <input
        className="palette__search"
        placeholder="Search tools…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        spellCheck={false}
      />
      <div className="palette__list">
        {grouped.map(([cat, list]) => (
          <div key={cat} className="palette__group">
            <div className="palette__group-title">{CATEGORY_LABELS[cat]}</div>
            {list.map((t) => (
              <button
                key={t.id}
                className="palette__item"
                onClick={() => onPick(t.id)}
                title={t.description}
              >
                <span className="palette__item-name">{t.name}</span>
                <span className="palette__item-desc">{t.description}</span>
              </button>
            ))}
          </div>
        ))}
        {empty && <div className="palette__empty">No tools match “{query}”.</div>}
      </div>
    </aside>
  )
}
