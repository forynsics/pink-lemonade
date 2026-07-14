import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Ban, Clock, Copy, Crosshair, Filter, List, Network, Radar, Tag, X } from 'lucide-react'
import type { CellRef } from './VirtualGrid'
import { TAG_DEFS, type TagId } from '../../state/tags'

// Right-click menu for a grid cell: quick filter-to / exclude the value, plus — when the cell
// is a time column — a ± window pivot (presets + custom). Also reused to EDIT a ± chip, in
// which case only the time section is shown, pre-filled with the chip's current window.

const MENU_W = 214

const PRESETS: Array<{ label: string; sec: number }> = [
  { label: '± 1 minute', sec: 60 },
  { label: '± 5 minutes', sec: 300 },
  { label: '± 10 minutes', sec: 600 },
  { label: '± 15 minutes', sec: 900 },
  { label: '± 30 minutes', sec: 1800 },
  { label: '± 1 hour', sec: 3600 }
]

export function CellContextMenu({
  cell,
  at,
  defaultMinutes,
  tagRids,
  currentTag,
  onFilter,
  onViewRow,
  onRecordEvent,
  onCopyRow,
  copyRowCount,
  onPickTime,
  onPickBound,
  onTag,
  onSend,
  sendLabel = 'Intel',
  onClearSighting,
  onClose
}: {
  cell: CellRef
  at: { x: number; y: number }
  /** When set, the menu is editing an existing ± chip — show only the time section, pre-filled. */
  defaultMinutes?: number
  /** Rows the Tag-as action targets (the clicked row, or a multi-row selection). Empty/undefined
   *  hides the tag section (e.g. legacy non-workspace tabs). */
  tagRids?: number[]
  /** The current tag of the single clicked row (shows a check + enables "Clear tag"). */
  currentTag?: string
  onFilter: (cell: CellRef, exclude: boolean) => void
  /** Open the full-row detail modal for the clicked row. Absent on multi-row selections + chip edits. */
  onViewRow?: () => void
  /** Record the acted-on row(s) as an analyst event (the analyst's own finding). Workspace sources only. */
  onRecordEvent?: () => void
  /** Copy the acted-on row(s) (header + values, tab-separated). Absent when there's no row (e.g. chip edit). */
  onCopyRow?: () => void
  /** How many rows "Copy row(s)" will copy — pluralizes the label when > 1. */
  copyRowCount?: number
  onPickTime: (cell: CellRef, deltaSec: number) => void
  onPickBound: (cell: CellRef, which: 'from' | 'to') => void
  onTag?: (rids: number[], tag: TagId | null) => void
  /** Set only when the cell value looks like an indicator (IP/domain/hash) → show "Send to <Intel>". */
  onSend?: () => void
  /** Label for the destination intel ("Global Intel" / "Workspace Intel"). */
  sendLabel?: string
  /** Set only when the clicked row is a sighting → show "Clear sighting" (drops its intel_hits). */
  onClearSighting?: () => void
  onClose: () => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [custom, setCustom] = useState(defaultMinutes != null ? String(defaultMinutes) : '')
  const editing = defaultMinutes != null

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  function applyCustom(): void {
    const m = Number(custom)
    if (Number.isFinite(m) && m > 0) {
      onPickTime(cell, Math.round(m * 60))
      onClose()
    }
  }

  // Open at the cursor, then nudge fully on-screen once the real height is known (the menu can be
  // tall — filter + tag + all the time presets). If it's still taller than the viewport it scrolls.
  const MARGIN = 8
  const [pos, setPos] = useState({ top: at.y, left: Math.min(at.x, window.innerWidth - MENU_W - MARGIN) })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const left = Math.max(MARGIN, Math.min(at.x, window.innerWidth - r.width - MARGIN))
    const top = Math.max(MARGIN, Math.min(at.y, window.innerHeight - r.height - MARGIN))
    setPos({ top, left })
  }, [at.x, at.y])

  const item =
    'w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs text-citrus-dark hover:bg-citrus-pink-light/60 dark:text-citrus-night-text dark:hover:bg-citrus-night-elev'

  return (
    <div
      ref={ref}
      className="cell-context-menu fixed z-50 flex flex-col rounded-lg border border-citrus-border bg-citrus-card shadow-lg overflow-y-auto overflow-x-hidden dark:border-citrus-night-border dark:bg-citrus-night-card"
      style={{ top: pos.top, left: pos.left, width: MENU_W, maxHeight: `calc(100vh - ${2 * MARGIN}px)` }}
    >
      <div className="px-3 py-1.5 border-b border-citrus-border/60 dark:border-citrus-night-border/60">
        <span className="text-[10px] font-mono text-citrus-muted truncate block dark:text-citrus-night-muted" title={cell.value}>
          {cell.value === '' ? '∅ (empty)' : cell.value}
        </span>
      </div>

      {!editing && (
        <>
          <button className={item} onClick={() => { onFilter(cell, false); onClose() }}>
            <Filter className="w-3.5 h-3.5 shrink-0 text-citrus-pink" />
            Filter to value
          </button>
          <button className={item} onClick={() => { onFilter(cell, true); onClose() }}>
            <Ban className="w-3.5 h-3.5 shrink-0 text-citrus-pink" />
            Exclude value
          </button>
          {onViewRow && (
            <button className={item} onClick={() => { onViewRow(); onClose() }}>
              <List className="w-3.5 h-3.5 shrink-0 text-citrus-pink" />
              View full row
            </button>
          )}
          {onRecordEvent && (
            <button className={item} onClick={() => { onRecordEvent(); onClose() }}>
              <Network className="w-3.5 h-3.5 shrink-0 text-citrus-pink" />
              {copyRowCount && copyRowCount > 1 ? `Record ${copyRowCount} rows as event` : 'Record as event'}
            </button>
          )}
          {onCopyRow && (
            <button className={item} onClick={() => { onCopyRow(); onClose() }}>
              <Copy className="w-3.5 h-3.5 shrink-0 text-citrus-pink" />
              {copyRowCount && copyRowCount > 1 ? `Copy ${copyRowCount} rows` : 'Copy row'}
            </button>
          )}
          {onSend && (
            <button className={item} onClick={() => { onSend(); onClose() }}>
              <Radar className="w-3.5 h-3.5 shrink-0 text-citrus-pink" />
              Send to {sendLabel}
            </button>
          )}
          {onClearSighting && (
            <button className={item} onClick={() => { onClearSighting(); onClose() }}>
              <Crosshair className="w-3.5 h-3.5 shrink-0 text-red-500 dark:text-red-400" />
              Clear sighting
            </button>
          )}
        </>
      )}

      {!editing && onTag && tagRids && tagRids.length > 0 && (
        <>
          <div className="flex items-center gap-1.5 px-3 py-1 border-t border-citrus-border/60 text-[10px] font-bold uppercase tracking-wide text-citrus-muted dark:border-citrus-night-border/60 dark:text-citrus-night-muted">
            <Tag className="w-3 h-3" /> {tagRids.length > 1 ? `Tag ${tagRids.length} rows as` : 'Tag row as'}
          </div>
          {TAG_DEFS.map((d) => (
            <button key={d.id} className={item} onClick={() => { onTag(tagRids, d.id); onClose() }}>
              <span className={`inline-block w-3 h-3 rounded-sm shrink-0 ${d.dot}`} />
              {d.label}
              {currentTag === d.id && <span className="ml-auto text-citrus-pink">✓</span>}
            </button>
          ))}
          {(currentTag || tagRids.length > 1) && (
            <button className={item} onClick={() => { onTag(tagRids, null); onClose() }}>
              <X className="w-3.5 h-3.5 shrink-0 text-citrus-muted dark:text-citrus-night-muted" />
              {tagRids.length > 1 ? `Clear tags (${tagRids.length} rows)` : 'Clear tag'}
            </button>
          )}
        </>
      )}

      {cell.tkind && (
        <>
          <div className="flex items-center gap-1.5 px-3 py-1 border-t border-citrus-border/60 text-[10px] font-bold uppercase tracking-wide text-citrus-muted dark:border-citrus-night-border/60 dark:text-citrus-night-muted">
            <Clock className="w-3 h-3" /> Time filter
          </div>
          {!editing && (
            <>
              <button className={item} onClick={() => { onPickBound(cell, 'from'); onClose() }}>
                <ArrowUp className="w-3.5 h-3.5 shrink-0 text-citrus-pink" />
                On/after this (≥)
              </button>
              <button className={item} onClick={() => { onPickBound(cell, 'to'); onClose() }}>
                <ArrowDown className="w-3.5 h-3.5 shrink-0 text-citrus-pink" />
                On/before this (≤)
              </button>
              <div className="px-3 py-0.5 text-[10px] text-citrus-muted dark:text-citrus-night-muted">around this:</div>
            </>
          )}
          {PRESETS.map((o) => (
            <button key={o.sec} className={item} onClick={() => { onPickTime(cell, o.sec); onClose() }}>
              {o.label}
            </button>
          ))}
          <div className="flex items-center gap-1.5 px-3 py-2 border-t border-citrus-border/60 dark:border-citrus-night-border/60">
            <span className="text-xs text-citrus-muted dark:text-citrus-night-muted">±</span>
            <input
              autoFocus={editing}
              type="number"
              min={1}
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && applyCustom()}
              placeholder="min"
              className="w-14 px-1.5 py-0.5 text-xs rounded border border-citrus-border bg-citrus-cream text-citrus-dark outline-none focus:border-citrus-pink dark:border-citrus-night-border dark:bg-citrus-night dark:text-citrus-night-text"
            />
            <span className="text-xs text-citrus-muted dark:text-citrus-night-muted">min</span>
            <button onClick={applyCustom} className="ml-auto px-2 py-0.5 rounded-md text-[11px] font-bold bg-citrus-pink text-white hover:bg-citrus-pink-hover">
              Apply
            </button>
          </div>
        </>
      )}
    </div>
  )
}
