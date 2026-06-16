import { useEffect, useState } from 'react'
import { Check, Filter, Plus, X } from 'lucide-react'
import type { CsvColumn, CsvFilter } from '../../state/csvTypes'
import { dtLocalToEpoch, epochToDtLocal, epochToLabel } from '../../state/timeKind'
import { tagDef } from '../../state/tags'

// Active row-filter chips + a compact add/edit form. Clicking a chip loads it back into the
// form for editing (eq/like/neq and time ≥/≤/between); `in` and ± chips delegate to their own
// editors. For a time column the operator list gains ≥ / ≤ / between with datetime inputs.

type Op = 'like' | 'nlike' | 'eq' | 'neq' | 'gte' | 'lte' | 'between'
const TIME_OPS: Op[] = ['gte', 'lte', 'between']

function fmtDelta(sec: number): string {
  if (sec % 3600 === 0) return `${sec / 3600}h`
  return `${Math.round(sec / 60)}m`
}

function chipText(f: CsvFilter, label: (n: string) => string): string {
  if (f.op === 'tag') return `tagged ${f.tags.map((t) => tagDef(t)?.label ?? t).join(' / ')}`
  if (f.op === 'sighting')
    return f.indicators?.length ? `sightings: ${f.indicators.length} indicator${f.indicators.length > 1 ? 's' : ''}` : 'all sightings'
  if (f.op === 'in') return `${label(f.col)} ∈ ${f.values.join(', ')}`
  if (f.op === 'timearound') return `${label(f.col)} ≈ ${f.value} ±${fmtDelta(f.deltaSec)}`
  if (f.op === 'timerange') {
    if (f.from != null && f.to != null) return `${label(f.col)} ${epochToLabel(f.from)} – ${epochToLabel(f.to)}`
    if (f.from != null) return `${label(f.col)} ≥ ${epochToLabel(f.from)}`
    return `${label(f.col)} ≤ ${epochToLabel(f.to ?? 0)}`
  }
  const sym = f.op === 'eq' ? '=' : f.op === 'neq' ? '≠' : f.op === 'nlike' ? '⊉' : '⊇'
  return `${label(f.col)} ${sym} ${f.value}`
}

export function FilterBar({
  columns,
  filters,
  onAdd,
  onUpdate,
  onRemove,
  onEditTimearound,
  onEditIn
}: {
  columns: CsvColumn[]
  filters: CsvFilter[]
  onAdd: (f: CsvFilter) => void
  onUpdate: (index: number, f: CsvFilter) => void
  onRemove: (index: number) => void
  onEditTimearound: (filter: CsvFilter, at: { x: number; y: number }) => void
  onEditIn: (filter: CsvFilter, at: { x: number; y: number }) => void
}): JSX.Element {
  const [col, setCol] = useState(columns[0]?.name ?? '')
  const [op, setOp] = useState<Op>('like')
  const [value, setValue] = useState('')
  const [value2, setValue2] = useState('')
  const [editIndex, setEditIndex] = useState<number | null>(null)

  const label = (name: string): string => columns.find((c) => c.name === name)?.original ?? name
  const tkind = columns.find((c) => c.name === col)?.time
  const isTimeOp = TIME_OPS.includes(op)

  useEffect(() => {
    if (!tkind && TIME_OPS.includes(op)) setOp('like')
  }, [tkind, op])

  function resetForm(): void {
    setEditIndex(null)
    setValue('')
    setValue2('')
  }

  // Clicking a chip → load it into the form for editing (or delegate the special kinds).
  function editChip(f: CsvFilter, i: number, at: { x: number; y: number }): void {
    if (f.op === 'tag') return // tag chips are toggled from the legend; only the ✕ removes them
    if (f.op === 'sighting') return // sighting chip is toggled from the sweep control; only ✕ removes it
    if (f.op === 'timearound') return onEditTimearound(f, at)
    if (f.op === 'in') return onEditIn(f, at)
    setEditIndex(i)
    setCol(f.col)
    if (f.op === 'timerange') {
      if (f.from != null && f.to != null) {
        setOp('between')
        setValue(epochToDtLocal(f.from).slice(0, 16))
        setValue2(epochToDtLocal(f.to).slice(0, 16))
      } else if (f.from != null) {
        setOp('gte')
        setValue(epochToDtLocal(f.from).slice(0, 16))
      } else {
        setOp('lte')
        setValue(epochToDtLocal(f.to ?? 0).slice(0, 16))
      }
    } else {
      setOp(f.op)
      setValue(f.value)
    }
  }

  function build(): CsvFilter | null {
    if (!col) return null
    if (isTimeOp) {
      if (!tkind) return null
      const from = dtLocalToEpoch(value)
      const to = dtLocalToEpoch(value2)
      if (op === 'gte' && from != null) return { col, op: 'timerange', tkind, from }
      if (op === 'lte' && from != null) return { col, op: 'timerange', tkind, to: from }
      if (op === 'between' && from != null && to != null) return { col, op: 'timerange', tkind, from, to }
      return null
    }
    if (value === '') return null
    return { col, op: op as 'like' | 'nlike' | 'eq' | 'neq', value }
  }

  function submit(): void {
    const f = build()
    if (!f) return
    if (editIndex != null) onUpdate(editIndex, f)
    else onAdd(f)
    resetForm()
  }

  const inputCls =
    'px-1.5 py-0.5 rounded border border-citrus-border bg-citrus-cream text-citrus-dark outline-none focus:border-citrus-pink dark:border-citrus-night-border dark:bg-citrus-night dark:text-citrus-night-text'

  return (
    <div className="flex items-center flex-wrap gap-1.5 px-3 py-1.5 text-[11px] border-b border-citrus-border/60 bg-citrus-sand/40 dark:border-citrus-night-border/60 dark:bg-citrus-night">
      <Filter className="w-3 h-3 text-citrus-muted dark:text-citrus-night-muted" />
      {filters.map((f, i) => (
        <span
          key={`${f.op === 'tag' || f.op === 'sighting' ? f.op : f.col}-${f.op}-${i}`}
          className={`filter-chip inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border font-mono ${
            f.op === 'tag' || f.op === 'sighting' ? '' : 'cursor-pointer'
          } ${
            editIndex === i
              ? 'bg-citrus-pink text-white border-citrus-pink'
              : 'bg-citrus-pink-light text-citrus-pink border-citrus-pink/20 hover:bg-citrus-pink-light/80'
          }`}
          title={f.op === 'tag' ? 'Tag filter — ✕ to clear' : 'Click to edit'}
          onClick={(e) => editChip(f, i, { x: e.clientX, y: e.clientY })}
        >
          {f.op === 'tag' &&
            f.tags.map((t) => <span key={t} className={`inline-block w-2 h-2 rounded-sm ${tagDef(t)?.dot ?? ''}`} />)}
          {chipText(f, label)}
          <button
            onClick={(e) => {
              e.stopPropagation()
              if (editIndex === i) resetForm()
              onRemove(i)
            }}
            title="Remove filter"
            className="hover:text-citrus-pink-hover"
          >
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
      <select className={inputCls} value={op} onChange={(e) => setOp(e.target.value as Op)}>
        <option value="like">contains</option>
        <option value="nlike">not contains</option>
        <option value="eq">equals</option>
        <option value="neq">≠ exclude</option>
        {tkind && <option value="gte">≥ on/after</option>}
        {tkind && <option value="lte">≤ on/before</option>}
        {tkind && <option value="between">between</option>}
      </select>
      {isTimeOp ? (
        <>
          <input
            type="datetime-local"
            className={inputCls}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
          {op === 'between' && (
            <>
              <span className="text-citrus-muted dark:text-citrus-night-muted">–</span>
              <input
                type="datetime-local"
                className={inputCls}
                value={value2}
                onChange={(e) => setValue2(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submit()}
              />
            </>
          )}
        </>
      ) : (
        <input
          className={`${inputCls} w-40`}
          value={value}
          placeholder="value…"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
      )}
      <button
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-citrus-pink hover:bg-citrus-pink-light font-semibold dark:hover:bg-citrus-night-elev"
        onClick={submit}
        title={editIndex != null ? 'Update filter' : 'Add filter'}
      >
        {editIndex != null ? <Check className="w-3 h-3" /> : <Plus className="w-3 h-3" />}
        {editIndex != null ? 'Update' : 'Filter'}
      </button>
      {editIndex != null && (
        <button
          className="px-1.5 py-0.5 rounded text-citrus-muted hover:text-citrus-pink dark:text-citrus-night-muted"
          onClick={resetForm}
          title="Cancel edit"
        >
          Cancel
        </button>
      )}
    </div>
  )
}
