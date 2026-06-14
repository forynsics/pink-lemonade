import { useState } from 'react'
import { Filter, Plus, X } from 'lucide-react'
import type { CsvColumn, CsvFilter } from '../../state/csvTypes'

// Active row-filter chips + a compact "add filter" form (column + contains/equals + value).
// Multi-value `in` filters come from a column's "Filter" submenu; this form only adds the
// single-value equals/contains kind.

export function FilterBar({
  columns,
  filters,
  onAdd,
  onRemove
}: {
  columns: CsvColumn[]
  filters: CsvFilter[]
  onAdd: (f: CsvFilter) => void
  onRemove: (index: number) => void
}): JSX.Element {
  const [col, setCol] = useState(columns[0]?.name ?? '')
  const [op, setOp] = useState<'like' | 'eq'>('like')
  const [value, setValue] = useState('')

  const label = (name: string): string => columns.find((c) => c.name === name)?.original ?? name

  function submit(): void {
    if (!col || value === '') return
    onAdd({ col, op, value })
    setValue('')
  }

  const inputCls =
    'px-1.5 py-0.5 rounded border border-citrus-border bg-citrus-cream text-citrus-dark outline-none focus:border-citrus-pink dark:border-citrus-night-border dark:bg-citrus-night dark:text-citrus-night-text'

  return (
    <div className="flex items-center flex-wrap gap-1.5 px-3 py-1.5 text-[11px] border-b border-citrus-border/60 bg-citrus-sand/40 dark:border-citrus-night-border/60 dark:bg-citrus-night">
      <Filter className="w-3 h-3 text-citrus-muted dark:text-citrus-night-muted" />
      {filters.map((f, i) => (
        <span
          key={`${f.col}-${f.op}-${i}`}
          className="filter-chip inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-citrus-pink-light text-citrus-pink border border-citrus-pink/20 font-mono"
          title={f.op === 'in' ? `${label(f.col)} in ${f.values.length} value(s)` : undefined}
        >
          {f.op === 'in'
            ? `${label(f.col)} ∈ ${f.values.join(', ')}`
            : `${label(f.col)} ${f.op === 'eq' ? '=' : '⊇'} ${f.value}`}
          <button onClick={() => onRemove(i)} title="Remove filter" className="hover:text-citrus-pink-hover">
            <X className="w-3 h-3" />
          </button>
        </span>
      ))}
      <select className={inputCls} value={col} onChange={(e) => setCol(e.target.value)}>
        {columns.map((c) => (
          <option key={c.name} value={c.name}>
            {c.original}
          </option>
        ))}
      </select>
      <select className={inputCls} value={op} onChange={(e) => setOp(e.target.value as 'like' | 'eq')}>
        <option value="like">contains</option>
        <option value="eq">equals</option>
      </select>
      <input
        className={`${inputCls} w-40`}
        value={value}
        placeholder="value…"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
      />
      <button
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-citrus-pink hover:bg-citrus-pink-light font-semibold dark:hover:bg-citrus-night-elev"
        onClick={submit}
        title="Add filter"
      >
        <Plus className="w-3 h-3" /> Filter
      </button>
    </div>
  )
}
