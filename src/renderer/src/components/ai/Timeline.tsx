import { useMemo, useState } from 'react'
import { ArrowDown, ArrowUp } from 'lucide-react'
import type { TimelineRow } from '../../state/timeline'

// Presentational: renders the curated timeline rows as an l2t_csv-style table (Time / Type / Source /
// Host / User / Description / Matched / Rows). Host-agnostic — the panel composes the rows; this just
// shows + sorts + filters them, pivots a clicked row to its evidence, and lets the analyst drag column
// borders to resize. Row counts are curated (small), so no virtualization needed.

type SortCol = 'time' | 'type' | 'source' | 'host'
type ColKey = SortCol | 'user' | 'description' | 'matched' | 'rows'

// Column order + default widths (px). table-fixed makes <col> widths authoritative, so a drag on a
// border resizes exactly that column without reflowing the others.
const COLS: Array<{ key: ColKey; label: string; sortable: boolean; w: number; align?: 'right' }> = [
  { key: 'time', label: 'Time', sortable: true, w: 132 },
  { key: 'type', label: 'Type', sortable: true, w: 96 },
  { key: 'source', label: 'Source', sortable: true, w: 150 },
  { key: 'host', label: 'Host', sortable: true, w: 96 },
  { key: 'user', label: 'User', sortable: false, w: 96 },
  { key: 'description', label: 'Description', sortable: false, w: 300 },
  { key: 'matched', label: 'Matched', sortable: false, w: 170 },
  { key: 'rows', label: 'Rows', sortable: false, w: 64, align: 'right' }
]
const MIN_W = 48

const HH = (epochSec: number): string => {
  const d = new Date(epochSec * 1000)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

export function Timeline({
  rows,
  onPivot
}: {
  rows: TimelineRow[]
  onPivot: (sourceId: number, rids: number[]) => void
}): JSX.Element {
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<{ col: SortCol; dir: 1 | -1 }>({ col: 'time', dir: 1 })
  const [widths, setWidths] = useState<Record<ColKey, number>>(() => Object.fromEntries(COLS.map((c) => [c.key, c.w])) as Record<ColKey, number>)

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    let out = needle
      ? rows.filter((r) => (r.time + ' ' + r.type + ' ' + r.source + ' ' + r.host + ' ' + r.user + ' ' + r.matched + ' ' + r.description).toLowerCase().includes(needle))
      : rows
    const { col, dir } = sort
    out = [...out].sort((a, b) => {
      if (col === 'time') {
        if (a.epoch == null && b.epoch == null) return 0
        if (a.epoch == null) return 1 // undated always last regardless of dir
        if (b.epoch == null) return -1
        return (a.epoch - b.epoch) * dir
      }
      const av = (a[col] ?? '').toString().toLowerCase()
      const bv = (b[col] ?? '').toString().toLowerCase()
      if (av === bv) return (a.epoch ?? Infinity) - (b.epoch ?? Infinity)
      return av < bv ? -dir : dir
    })
    return out
  }, [rows, q, sort])

  const toggleSort = (col: SortCol): void => setSort((s) => (s.col === col ? { col, dir: s.dir === 1 ? -1 : 1 } : { col, dir: 1 }))

  const startResize = (key: ColKey, e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation() // don't trigger the header's sort toggle
    const startX = e.clientX
    const startW = widths[key]
    const onMove = (ev: MouseEvent): void => setWidths((w) => ({ ...w, [key]: Math.max(MIN_W, startW + (ev.clientX - startX)) }))
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const headBase = 'sticky top-0 z-10 bg-citrus-sand/80 px-2 py-1.5 font-bold backdrop-blur dark:bg-citrus-night-elev/90'
  const grip = (
    <span
      // a thin drag zone on the column's right border
      className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize select-none hover:bg-citrus-pink/40"
    />
  )

  return (
    <div className="timeline flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-citrus-border/60 px-3 py-2 dark:border-citrus-night-border/60">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter timeline…"
          className="w-full rounded-md border border-citrus-border bg-citrus-bg px-2 py-1 text-[12px] text-citrus-dark outline-none focus:border-citrus-pink/60 dark:border-citrus-night-border dark:bg-citrus-night-bg dark:text-citrus-night-text"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {shown.length === 0 ? (
          <div className="px-3 py-8 text-center text-[12px] text-citrus-muted dark:text-citrus-night-muted">
            {rows.length === 0 ? 'No events recorded yet.' : 'No rows match the filter.'}
          </div>
        ) : (
          <table className="table-fixed border-collapse text-[11px]" style={{ width: COLS.reduce((sum, c) => sum + widths[c.key], 0) }}>
            <colgroup>
              {COLS.map((c) => (
                <col key={c.key} style={{ width: widths[c.key] }} />
              ))}
            </colgroup>
            <thead>
              <tr className="text-citrus-muted dark:text-citrus-night-muted">
                {COLS.map((c) => (
                  <th key={c.key} className={`relative ${headBase} ${c.align === 'right' ? 'text-right' : 'text-left'}`}>
                    {c.sortable ? (
                      <button onClick={() => toggleSort(c.key as SortCol)} className="inline-flex max-w-full items-center gap-1 truncate hover:text-citrus-pink">
                        <span className="truncate">{c.label}</span>
                        {sort.col === c.key && (sort.dir === 1 ? <ArrowUp className="w-3 h-3 shrink-0" /> : <ArrowDown className="w-3 h-3 shrink-0" />)}
                      </button>
                    ) : (
                      <span className="block truncate">{c.label}</span>
                    )}
                    <span onMouseDown={(e) => startResize(c.key, e)} title="Drag to resize">
                      {grip}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((r, i) => {
                const canPivot = r.sourceId >= 0 && r.rids.length > 0
                return (
                  <tr
                    key={`${r.eventId}-${r.source}-${r.type}-${r.epoch}-${i}`}
                    onClick={() => canPivot && onPivot(r.sourceId, r.rids)}
                    title={canPivot ? `Jump to the ${r.rids.length} evidence row(s) in ${r.source}` : undefined}
                    className={`border-b border-citrus-border/40 dark:border-citrus-night-border/40 ${
                      canPivot ? 'cursor-pointer hover:bg-citrus-pink/5' : ''
                    }`}
                  >
                    <td className="truncate px-2 py-1 font-mono text-citrus-dark dark:text-citrus-night-text" title={r.time}>
                      {r.time || <span className="text-citrus-muted dark:text-citrus-night-muted">—</span>}
                      {r.endEpoch != null && <span className="text-citrus-muted dark:text-citrus-night-muted"> →{HH(r.endEpoch)}</span>}
                    </td>
                    <td className="truncate px-2 py-1 text-citrus-muted dark:text-citrus-night-muted" title={r.type}>{r.type}</td>
                    <td className="truncate px-2 py-1 text-citrus-dark dark:text-citrus-night-text" title={r.source}>{r.source}</td>
                    <td className="truncate px-2 py-1" title={r.host}>
                      {r.host ? (
                        <span className="text-citrus-pink">{r.host}</span>
                      ) : (
                        <span className="text-citrus-muted dark:text-citrus-night-muted">—</span>
                      )}
                    </td>
                    <td className="truncate px-2 py-1" title={r.user}>
                      {r.user ? (
                        <span className="text-citrus-dark dark:text-citrus-night-text">{r.user}</span>
                      ) : (
                        <span className="text-citrus-muted dark:text-citrus-night-muted">—</span>
                      )}
                    </td>
                    <td className="truncate px-2 py-1 text-citrus-dark dark:text-citrus-night-text" title={r.description}>{r.description}</td>
                    <td className="truncate px-2 py-1 font-mono text-citrus-dark dark:text-citrus-night-text" title={r.matched}>
                      {r.matched || <span className="text-citrus-muted dark:text-citrus-night-muted">—</span>}
                    </td>
                    <td className="truncate px-2 py-1 text-right font-mono text-citrus-muted dark:text-citrus-night-muted">{r.rows}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
