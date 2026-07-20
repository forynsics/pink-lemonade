import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Clock, Crosshair, Fingerprint, Maximize2, Pencil, Radar, Share2, Trash2, User, X } from 'lucide-react'
import type { CsvEvent, CsvIoc } from '../../state/csvTypes'
import { deriveIocLinks } from '../../state/iocLinks'
import { IOC_TYPES, TYPE_ORDER, ENRICHABLE } from '../../../../shared/iocTypes'

// The Artifact Constellation — host-agnostic so it can live in a side panel OR a pop-out window.
// Nodes are EVENTS (actions that transpired — TTPs). Two views: GRAPH (each event branches to the
// artifacts/sources whose rows corroborate it; a shared artifact links events) and TIME AXIS (each
// event as a min–max span bar on a UTC time axis; undated events drop to a separate lane). NOTE: this
// is NOT the Timeline feature — "Timeline" in this app means the tabular Plaso/l2t_csv super-timeline
// (TimelinePanel); this constellation view is the "Time axis".
// Pan by dragging, zoom with the wheel; click an event to see its evidence and jump to those rows.

const EX = 90 // event column x
const SX = 500 // source column x
const R = 7
const VSPACE = 46
const TOP = 34

// IOCs view: indicators on the left, the events they appear in on the right.
const IOCX = 150 // IOC column x
const IEVX = 560 // event column x (IOCs view)
const IHEADER_H = 24

type Mode = 'graph' | 'timeaxis' | 'iocs'

// IOC taxonomy labels/order/enrichability come from src/shared — the ONE definition, shared with the
// IOC panel and the AI toolbox. A local copy here had already drifted (it was missing `account`), so
// an account IOC rendered with its raw type and sorted last: exactly the silent failure src/shared
// exists to prevent. Unknown types still fall back to raw.
const iocTypeLabel = (t: string): string => IOC_TYPES[t] ?? t
const iocTypeRank = (t: string): number => {
  const i = TYPE_ORDER.indexOf(t)
  return i === -1 ? TYPE_ORDER.length : i
}
/** Shorten a long indicator (e.g. a SHA256) for the node label; full value stays in the tooltip. */
const shortIoc = (v: string): string => (v.length > 24 ? `${v.slice(0, 12)}…${v.slice(-8)}` : v)

/** An event's epoch-second span = min/max across its evidence (null when no evidence is dated). */
function eventSpan(ev: CsvEvent): { min: number | null; max: number | null } {
  let min: number | null = null
  let max: number | null = null
  for (const e of ev.evidence) {
    if (e.tsMin != null) min = min == null ? e.tsMin : Math.min(min, e.tsMin)
    if (e.tsMax != null) max = max == null ? e.tsMax : Math.max(max, e.tsMax)
  }
  return { min, max }
}

const pad2 = (n: number): string => String(n).padStart(2, '0')
/** Compact UTC label for an axis tick: "MM-DD HH:MM". */
function fmtTick(epochSec: number): string {
  const d = new Date(epochSec * 1000)
  return `${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`
}
/** Full UTC timestamp for a tooltip. */
function fmtFull(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString().replace('.000Z', 'Z')
}

export function Constellation({
  events,
  iocs,
  iocLinks,
  sources,
  onPivot,
  onDelete,
  onUpdate,
  onDeleteEvidence,
  onSendToIntel,
  focusEventId
}: {
  events: CsvEvent[]
  /** Catalogued IOCs, for the "IOCs" view (indicators linked to the events they appear in). */
  iocs?: CsvIoc[]
  /** Content-based IOC→event links (iocId → eventIds whose evidence rows contain the value), from the
   *  worker — unioned with the renderer's label/text match to draw the IOCs-view edges. */
  iocLinks?: Array<{ iocId: string; eventIds: string[] }>
  /** Source id → group label (the host/system the artifact came from), for clustering the source column. */
  sources?: Array<{ sourceId: number; group?: string | null }>
  /** Jump the grid to this evidence's EXACT rows (rids) in source `sourceId`. */
  onPivot: (sourceId: number, rids: number[]) => void
  onDelete?: (id: string) => void
  /** Save analyst edits to an event's INTERPRETATION (label/description/technique/users). Evidence untouched. */
  onUpdate?: (id: string, fields: { label: string; description: string | null; technique: string | null; users: string[] }) => void
  /** Remove a single piece of evidence from an event (re-grouping — no source row touched). */
  onDeleteEvidence?: (evidenceId: number) => void
  /** Send an enrichable IOC's value to the Intel grid (omitted in the pop-out window). */
  onSendToIntel?: (values: string[]) => void
  /** Drive selection from outside — the Case Report's "open" jumps here with the event selected so its
   *  citations are visible. A {id,token} so re-opening the SAME event re-selects it. */
  focusEventId?: { id: string; token: number } | null
}): JSX.Element {
  const [view, setView] = useState({ tx: 0, ty: 0, scale: 1 })
  const [mode, setMode] = useState<Mode>('graph')
  const [selected, setSelected] = useState<string | null>(null)
  // Honour an external focus request (from the Case Report). Keyed on token so clicking the same
  // event twice still re-selects it, even though its id did not change.
  useEffect(() => {
    if (focusEventId?.id) setSelected(focusEventId.id)
  }, [focusEventId?.id, focusEventId?.token])
  const [selIoc, setSelIoc] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState({ label: '', technique: '', description: '', users: '' })
  const beginEdit = (ev: CsvEvent): void => {
    setConfirmDelete(null)
    setEditing(ev.id)
    setDraft({ label: ev.label, technique: ev.technique ?? '', description: ev.description ?? '', users: (ev.users ?? []).join(', ') })
  }
  const saveEdit = (): void => {
    if (!editing) return
    const label = draft.label.trim()
    // User attribution is a comma-separated list; the db trims/dedups/caps it.
    const users = draft.users.split(',').map((u) => u.trim()).filter(Boolean)
    if (label) onUpdate?.(editing, { label, description: draft.description.trim() || null, technique: draft.technique.trim() || null, users })
    setEditing(null)
  }
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null)

  const groupOf = useMemo(() => {
    const m = new Map((sources ?? []).map((s) => [s.sourceId, s.group ?? null]))
    return (id: number): string | null => m.get(id) ?? null
  }, [sources])

  const layout = useMemo(() => {
    // Unique sources cited by the events, clustered by GROUP (host/system) — a "folder" per group,
    // ungrouped last — so the graph shows which machine each corroborating artifact belongs to.
    const uniq = new Map<number, { sourceId: number; sourceName: string; group: string | null }>()
    for (const ev of events) {
      for (const e of ev.evidence) {
        if (!uniq.has(e.sourceId)) uniq.set(e.sourceId, { sourceId: e.sourceId, sourceName: e.sourceName, group: groupOf(e.sourceId) })
      }
    }
    const hasGroups = [...uniq.values()].some((s) => s.group)
    const ordered = [...uniq.values()].sort((a, b) => {
      const ga = a.group ?? '￿' // ungrouped sorts last
      const gb = b.group ?? '￿'
      if (ga !== gb) return ga < gb ? -1 : 1
      return a.sourceName < b.sourceName ? -1 : 1
    })
    const HEADER_H = 24
    const sourceNodes: Array<{ sourceId: number; sourceName: string; group: string | null; y: number }> = []
    const groupHeaders: Array<{ group: string; y: number; bottom: number }> = []
    let y = TOP
    let last: string | null | undefined = undefined
    for (const s of ordered) {
      const g = s.group ?? null
      if (hasGroups && g !== last) {
        groupHeaders.push({ group: g ?? 'Ungrouped', y, bottom: y })
        y += HEADER_H
        last = g
      }
      sourceNodes.push({ ...s, y })
      if (groupHeaders.length) groupHeaders[groupHeaders.length - 1].bottom = y
      y += VSPACE
    }
    const sourceMap = new Map(sourceNodes.map((s) => [s.sourceId, s]))
    const eventNodes = events.map((ev, i) => ({ ev, x: EX, y: TOP + i * VSPACE }))
    const eventY = new Map(eventNodes.map((n) => [n.ev.id, n.y]))
    // One edge per (event, source) for a clean graph, even if the event has several evidence there.
    const edges: Array<{ id: string; eventId: string; fy: number; sy: number }> = []
    for (const ev of events) {
      const seen = new Set<number>()
      for (const e of ev.evidence) {
        if (seen.has(e.sourceId)) continue
        seen.add(e.sourceId)
        edges.push({ id: `${ev.id}->${e.sourceId}`, eventId: ev.id, fy: eventY.get(ev.id) ?? 0, sy: sourceMap.get(e.sourceId)?.y ?? 0 })
      }
    }
    return { sources: sourceNodes, eventNodes, edges, groupHeaders }
  }, [events, groupOf])

  // Time-axis layout: dated events become min–max span bars packed into lanes (greedy, no overlap)
  // on a UTC axis; undated events drop to a lane of their own below. Coordinates are in a fixed base
  // space — the same pan/zoom transform applies.
  const TL = { LEFT: 80, TIME_W: 1040, TOP: 56, LANE_H: 34, MINBAR: 7, LABEL_GAP: 150 }
  const timeAxis = useMemo(() => {
    const spans = events.map((ev) => ({ ev, ...eventSpan(ev) }))
    const dated = spans.filter((s): s is { ev: CsvEvent; min: number; max: number | null } => s.min != null)
    const undated = spans.filter((s) => s.min == null)

    // Robust axis domain: forensic artifacts carry sentinel / timestomped timestamps (e.g. a 2080 MFT
    // $FILE_NAME date) that would otherwise squash the real cluster. Trim far-outliers with Tukey 3×IQR
    // fences and derive the domain from the inliers; out-of-domain endpoints clamp to the edge + a caret.
    const ends: number[] = []
    for (const s of dated) {
      ends.push(s.min)
      if (s.max != null) ends.push(s.max)
    }
    const ep = [...ends].sort((a, b) => a - b)
    const q = (p: number): number => {
      if (ep.length === 0) return 0
      const idx = (ep.length - 1) * p
      const lo = Math.floor(idx)
      const hi = Math.ceil(idx)
      return ep[lo] + (ep[hi] - ep[lo]) * (idx - lo)
    }
    let lo: number
    let hi: number
    if (ep.length >= 4) {
      const q1 = q(0.25)
      const q3 = q(0.75)
      const iqr = q3 - q1
      const inl = ep.filter((v) => v >= q1 - 3 * iqr && v <= q3 + 3 * iqr)
      lo = inl.length ? inl[0] : ep[0]
      hi = inl.length ? inl[inl.length - 1] : ep[ep.length - 1]
    } else {
      lo = ep[0] ?? Infinity
      hi = ep[ep.length - 1] ?? -Infinity
    }
    const hasRange = dated.length > 0 && Number.isFinite(lo)
    const range = hasRange ? Math.max(1, hi - lo) : 1
    const clampX = (x: number): number => Math.max(TL.LEFT, Math.min(TL.LEFT + TL.TIME_W, x))
    const xOf = (ts: number): number => clampX(TL.LEFT + ((ts - lo) / range) * TL.TIME_W)
    const laneEnd: number[] = [] // running pixel x-end (incl. label) per lane
    const bars = [...dated]
      .sort((a, b) => a.min - b.min)
      .map((s) => {
        const max = s.max ?? s.min
        const x0 = xOf(s.min)
        const x1 = Math.max(x0 + TL.MINBAR, xOf(max))
        let lane = laneEnd.findIndex((end) => end <= x0 - 8)
        if (lane === -1) {
          lane = laneEnd.length
          laneEnd.push(0)
        }
        laneEnd[lane] = x1 + TL.LABEL_GAP
        return { ev: s.ev, x0, x1, y: TL.TOP + lane * TL.LANE_H, instant: max === s.min, min: s.min, max, offLeft: s.min < lo, offRight: max > hi }
      })
    const undatedY = TL.TOP + (laneEnd.length + 1) * TL.LANE_H
    const undatedNodes = undated.map((s, i) => ({ ev: s.ev, x: TL.LEFT + (i % 6) * 170, y: undatedY + Math.floor(i / 6) * TL.LANE_H }))
    const ticks = hasRange ? Array.from({ length: 5 }, (_, i) => { const ts = lo + (range * i) / 4; return { x: xOf(ts), label: fmtTick(ts) } }) : []
    const axisBottom = undated.length > 0 ? undatedY + Math.ceil(undated.length / 6) * TL.LANE_H : TL.TOP + (laneEnd.length + 1) * TL.LANE_H
    return { bars, undatedNodes, ticks, hasRange, undatedY, axisBottom }
  }, [events])

  // IOCs layout: indicators (left) clustered by type, each linked to the events (right) it appears in.
  // Unlinked indicators stay in their type cluster, greyed with no edge. Only events with ≥1 linked
  // IOC appear on the right, so the graph stays about the relationship.
  const iocLayout = useMemo(() => {
    const { linked, unlinked } = deriveIocLinks(iocs ?? [], events, iocLinks ?? [])
    const linkMap = new Map(linked.map((l) => [l.ioc.id, l.eventIds]))

    const linkedEventIds = new Set(linked.flatMap((l) => l.eventIds))
    const evNodes = events.filter((ev) => linkedEventIds.has(ev.id)).map((ev, i) => ({ ev, y: TOP + i * VSPACE }))
    const evY = new Map(evNodes.map((n) => [n.ev.id, n.y]))

    // Order all IOCs by type (taxonomy order), then value; place with a header per type cluster.
    const ordered = [...(iocs ?? [])].sort((a, b) => {
      if (a.type !== b.type) return iocTypeRank(a.type) - iocTypeRank(b.type) || (a.type < b.type ? -1 : 1)
      return a.value < b.value ? -1 : 1
    })
    const iocNodes: Array<{ ioc: CsvIoc; y: number; eventIds: string[] }> = []
    const typeHeaders: Array<{ type: string; y: number }> = []
    let y = TOP
    let last: string | undefined
    for (const ioc of ordered) {
      if (ioc.type !== last) {
        typeHeaders.push({ type: ioc.type, y })
        y += IHEADER_H
        last = ioc.type
      }
      iocNodes.push({ ioc, y, eventIds: linkMap.get(ioc.id) ?? [] })
      y += VSPACE
    }

    const edges: Array<{ id: string; iocId: string; eventId: string; fy: number; sy: number }> = []
    for (const n of iocNodes) {
      for (const eid of n.eventIds) {
        const ey = evY.get(eid)
        if (ey != null) edges.push({ id: `${n.ioc.id}->${eid}`, iocId: n.ioc.id, eventId: eid, fy: n.y, sy: ey })
      }
    }
    return { iocNodes, evNodes, edges, typeHeaders, linkedCount: linked.length, unlinkedCount: unlinked.length }
  }, [iocs, events, iocLinks])

  function onWheel(e: React.WheelEvent<SVGSVGElement>): void {
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1
    const rect = e.currentTarget.getBoundingClientRect()
    const px = e.clientX - rect.left
    const py = e.clientY - rect.top
    setView((v) => {
      const scale = Math.min(3, Math.max(0.2, v.scale * factor))
      const k = scale / v.scale
      return { scale, tx: px - k * (px - v.tx), ty: py - k * (py - v.ty) }
    })
  }
  function onMouseDown(e: React.MouseEvent<SVGSVGElement>): void {
    if ((e.target as Element).closest('[data-node]')) return
    drag.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty }
  }
  function onMouseMove(e: React.MouseEvent<SVGSVGElement>): void {
    const d = drag.current
    if (!d) return
    setView((v) => ({ ...v, tx: d.tx + (e.clientX - d.x), ty: d.ty + (e.clientY - d.y) }))
  }
  const endDrag = (): void => {
    drag.current = null
  }

  const sel = events.find((ev) => ev.id === selected) ?? null

  if (events.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-[12px] text-citrus-muted dark:text-citrus-night-muted">
        No events yet — your AI agent records them here as it investigates, each linked to its corroborating rows.
      </div>
    )
  }

  return (
    <div className="relative h-full w-full overflow-hidden">
      <svg className="h-full w-full cursor-grab active:cursor-grabbing" onWheel={onWheel} onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={endDrag} onMouseLeave={endDrag}>
        <g transform={`translate(${view.tx},${view.ty}) scale(${view.scale})`}>
          {mode === 'graph' && (
            <>
          {layout.edges.map((e) => {
            const active = selected == null || e.eventId === selected
            const midX = (EX + SX) / 2
            return (
              <path
                key={e.id}
                d={`M ${EX + R} ${e.fy} C ${midX} ${e.fy}, ${midX} ${e.sy}, ${SX - R} ${e.sy}`}
                fill="none"
                stroke={active ? '#f472b6' : '#cbd5e1'}
                strokeOpacity={active ? 0.75 : 0.2}
                strokeWidth={active ? 1.5 : 1}
              />
            )
          })}
          {layout.groupHeaders.map((h) => (
            <g key={`gh-${h.group}-${h.y}`}>
              {/* a faint bracket spanning the group's source cluster — the "folder" */}
              <line x1={SX - 16} y1={h.y + 18} x2={SX - 16} y2={h.bottom + 5} stroke="#ec4899" strokeOpacity={0.3} strokeWidth={1} />
              <g transform={`translate(${SX - 16},${h.y + 6})`}>
                <path d="M0 0 h4 l1.3 1.7 h6.2 v6.8 h-11.5 z" fill="#ec4899" fillOpacity={0.18} stroke="#ec4899" strokeOpacity={0.6} strokeWidth={0.8} />
                <text x={16} y={8} fontSize={10} fontWeight={700} className="fill-citrus-pink">
                  {h.group}
                </text>
              </g>
            </g>
          ))}
          {layout.sources.map((s) => {
            const active = sel == null || sel.evidence.some((e) => e.sourceId === s.sourceId)
            return (
              <g key={s.sourceId} transform={`translate(${SX},${s.y})`} opacity={active ? 1 : 0.3}>
                <circle r={R - 1} fill="#94a3b8" />
                <text x={R + 5} y={4} className="fill-citrus-dark dark:fill-citrus-night-text" fontSize={11}>
                  {s.sourceName}
                </text>
              </g>
            )
          })}
          {layout.eventNodes.map((n) => {
            const isSel = n.ev.id === selected
            const dim = selected != null && !isSel
            return (
              <g
                key={n.ev.id}
                data-node
                transform={`translate(${EX},${n.y})`}
                opacity={dim ? 0.35 : 1}
                className="cursor-pointer"
                onClick={() => {
                  setConfirmDelete(null)
                  setSelected(isSel ? null : n.ev.id)
                }}
              >
                {n.ev.actor === 'analyst' && (
                  <circle r={(isSel ? R + 2 : R) + 3} fill="none" stroke="#10b981" strokeWidth={1.5} strokeDasharray="2 2" />
                )}
                <circle r={isSel ? R + 2 : R} fill={n.ev.technique ? '#ec4899' : '#f59e0b'} stroke={isSel ? '#ec4899' : 'transparent'} strokeWidth={2} />
                <text x={-(R + 5)} y={4} textAnchor="end" className="fill-citrus-dark dark:fill-citrus-night-text" fontSize={11} fontWeight={isSel ? 700 : 400}>
                  {n.ev.label}
                </text>
              </g>
            )
          })}
            </>
          )}

          {mode === 'timeaxis' && (
            <>
              {!timeAxis.hasRange && (
                <text x={TL.LEFT} y={28} fontSize={11} className="fill-citrus-muted dark:fill-citrus-night-muted">
                  No timestamped evidence yet — the events below are undated.
                </text>
              )}
              {timeAxis.hasRange && (
                <>
                  <text x={TL.LEFT} y={20} fontSize={10} className="fill-citrus-muted dark:fill-citrus-night-muted">
                    UTC
                  </text>
                  <line x1={TL.LEFT} y1={42} x2={TL.LEFT + TL.TIME_W} y2={42} stroke="#cbd5e1" strokeWidth={1} />
                  {timeAxis.ticks.map((t, i) => (
                    <g key={i}>
                      <line x1={t.x} y1={42} x2={t.x} y2={timeAxis.axisBottom} stroke="#e2e8f0" strokeWidth={1} strokeDasharray="2 4" />
                      <text x={t.x} y={34} textAnchor="middle" fontSize={10} className="fill-citrus-muted dark:fill-citrus-night-muted">
                        {t.label}
                      </text>
                    </g>
                  ))}
                </>
              )}
              {timeAxis.bars.map((b) => {
                const isSel = b.ev.id === selected
                const dim = selected != null && !isSel
                const color = b.ev.technique ? '#ec4899' : '#f59e0b'
                return (
                  <g
                    key={b.ev.id}
                    data-node
                    opacity={dim ? 0.35 : 1}
                    className="cursor-pointer"
                    onClick={() => {
                      setConfirmDelete(null)
                      setSelected(isSel ? null : b.ev.id)
                    }}
                  >
                    {b.instant ? (
                      <circle cx={b.x0} cy={b.y} r={isSel ? R : R - 1} fill={color} stroke={isSel ? color : 'transparent'} strokeWidth={2} />
                    ) : (
                      <rect x={b.x0} y={b.y - 5} width={Math.max(TL.MINBAR, b.x1 - b.x0)} height={10} rx={4} fill={color} fillOpacity={isSel ? 1 : 0.8} stroke={isSel ? color : 'transparent'} strokeWidth={2} />
                    )}
                    {b.offLeft && (
                      <text x={b.x0 - 4} y={b.y + 4} textAnchor="end" fontSize={12} fill={color}>‹</text>
                    )}
                    {b.offRight && (
                      <text x={b.x1 + 2} y={b.y + 4} fontSize={12} fill={color}>›</text>
                    )}
                    <title>{`${b.ev.label}\n${fmtFull(b.min)}${b.instant ? '' : ` → ${fmtFull(b.max)}`}${b.offLeft || b.offRight ? '\n(extends beyond axis — outlier timestamp)' : ''}`}</title>
                    <text x={b.x1 + 8} y={b.y + 4} fontSize={11} fontWeight={isSel ? 700 : 400} className="fill-citrus-dark dark:fill-citrus-night-text">
                      {b.ev.label}
                    </text>
                  </g>
                )
              })}
              {timeAxis.undatedNodes.length > 0 && (
                <>
                  <text x={TL.LEFT} y={timeAxis.undatedY - 12} fontSize={10} className="fill-citrus-muted dark:fill-citrus-night-muted">
                    undated
                  </text>
                  {timeAxis.undatedNodes.map((n) => {
                    const isSel = n.ev.id === selected
                    const dim = selected != null && !isSel
                    const color = n.ev.technique ? '#ec4899' : '#f59e0b'
                    return (
                      <g
                        key={n.ev.id}
                        data-node
                        transform={`translate(${n.x},${n.y})`}
                        opacity={dim ? 0.35 : 1}
                        className="cursor-pointer"
                        onClick={() => {
                          setConfirmDelete(null)
                          setSelected(isSel ? null : n.ev.id)
                        }}
                      >
                        <circle r={isSel ? R : R - 1} fill={color} stroke={isSel ? color : 'transparent'} strokeWidth={2} />
                        <text x={R + 4} y={4} fontSize={11} fontWeight={isSel ? 700 : 400} className="fill-citrus-dark dark:fill-citrus-night-text">
                          {n.ev.label}
                        </text>
                      </g>
                    )
                  })}
                </>
              )}
            </>
          )}

          {mode === 'iocs' && (
            <>
              {iocLayout.iocNodes.length === 0 && (
                <text x={IOCX} y={TOP} fontSize={11} className="fill-citrus-muted dark:fill-citrus-night-muted">
                  No IOCs catalogued yet — as your AI agent records indicators, they appear here linked to the events they show up in.
                </text>
              )}
              {iocLayout.edges.map((e) => {
                const active = (selIoc == null && selected == null) || e.iocId === selIoc || e.eventId === selected
                const midX = (IOCX + IEVX) / 2
                return (
                  <path
                    key={e.id}
                    d={`M ${IOCX + R} ${e.fy} C ${midX} ${e.fy}, ${midX} ${e.sy}, ${IEVX - R} ${e.sy}`}
                    fill="none"
                    stroke={active ? '#14b8a6' : '#cbd5e1'}
                    strokeOpacity={active ? 0.7 : 0.18}
                    strokeWidth={active ? 1.5 : 1}
                  />
                )
              })}
              {iocLayout.typeHeaders.map((h) => (
                <text key={`${h.type}-${h.y}`} x={IOCX} y={h.y + 14} textAnchor="end" fontSize={10} fontWeight={700} className="fill-citrus-pink">
                  {iocTypeLabel(h.type)}
                </text>
              ))}
              {iocLayout.iocNodes.map((n) => {
                const isSel = n.ioc.id === selIoc
                const linkedToSelEvent = selected != null && n.eventIds.includes(selected)
                const dim = (selIoc != null && !isSel && !linkedToSelEvent) || (selected != null && !linkedToSelEvent)
                const hasLinks = n.eventIds.length > 0
                return (
                  <g
                    key={n.ioc.id}
                    data-node
                    transform={`translate(${IOCX},${n.y})`}
                    opacity={dim ? 0.3 : 1}
                    className="cursor-pointer"
                    onClick={() => {
                      setConfirmDelete(null)
                      setSelected(null)
                      setSelIoc(isSel ? null : n.ioc.id)
                    }}
                  >
                    <circle r={isSel ? R + 2 : R - 1} fill={hasLinks ? '#14b8a6' : '#94a3b8'} stroke={isSel ? '#14b8a6' : 'transparent'} strokeWidth={2} />
                    <title>{`${n.ioc.value}\n${iocTypeLabel(n.ioc.type)}${hasLinks ? ` · in ${n.eventIds.length} event${n.eventIds.length === 1 ? '' : 's'}` : ' · not found in any event'}`}</title>
                    <text x={-(R + 5)} y={4} textAnchor="end" fontSize={11} fontWeight={isSel ? 700 : 400} className="fill-citrus-dark font-mono dark:fill-citrus-night-text">
                      {shortIoc(n.ioc.value)}
                    </text>
                  </g>
                )
              })}
              {iocLayout.evNodes.map((n) => {
                const selIocEventIds = selIoc != null ? (iocLayout.iocNodes.find((i) => i.ioc.id === selIoc)?.eventIds ?? []) : null
                const isSel = n.ev.id === selected
                const linkedToSelIoc = selIocEventIds?.includes(n.ev.id) ?? false
                const dim = (selected != null && !isSel) || (selIoc != null && !linkedToSelIoc)
                return (
                  <g
                    key={n.ev.id}
                    data-node
                    transform={`translate(${IEVX},${n.y})`}
                    opacity={dim ? 0.3 : 1}
                    className="cursor-pointer"
                    onClick={() => {
                      setConfirmDelete(null)
                      setSelIoc(null)
                      setSelected(isSel ? null : n.ev.id)
                    }}
                  >
                    <circle r={isSel ? R + 1 : R - 1} fill={n.ev.technique ? '#ec4899' : '#f59e0b'} stroke={isSel ? '#ec4899' : 'transparent'} strokeWidth={2} />
                    <text x={R + 5} y={4} fontSize={11} fontWeight={isSel ? 700 : 400} className="fill-citrus-dark dark:fill-citrus-night-text">
                      {n.ev.label}
                    </text>
                  </g>
                )
              })}
            </>
          )}
        </g>
      </svg>

      <div className="absolute left-3 top-3 inline-flex overflow-hidden rounded-md border border-citrus-border bg-citrus-card/90 text-[10px] font-semibold dark:border-citrus-night-border dark:bg-citrus-night-card/90">
        {([['graph', 'Graph', Share2], ['timeaxis', 'Time axis', Clock], ['iocs', 'IOCs', Fingerprint]] as const).map(([m, label, Icon]) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            title={m === 'graph' ? 'Events and their evidence' : m === 'timeaxis' ? 'Events on a time axis' : 'IOCs and their events'}
            className={`inline-flex items-center gap-1 px-2 py-1 ${mode === m ? 'bg-citrus-pink/15 text-citrus-pink' : 'text-citrus-muted hover:text-citrus-pink dark:text-citrus-night-muted'}`}
          >
            <Icon className="w-3 h-3" /> {label}
          </button>
        ))}
      </div>

      <button
        onClick={() => setView({ tx: 0, ty: 0, scale: 1 })}
        title="Reset view"
        className="absolute right-3 top-3 inline-flex items-center gap-1 rounded-md border border-citrus-border bg-citrus-card/90 px-2 py-1 text-[10px] font-semibold text-citrus-muted hover:text-citrus-pink dark:border-citrus-night-border dark:bg-citrus-night-card/90"
      >
        <Maximize2 className="w-3 h-3" /> Reset
      </button>

      {sel && (
        <div className="absolute bottom-3 left-3 w-80 max-w-[85%] rounded-lg border border-citrus-border bg-citrus-card/95 p-3 shadow-lg backdrop-blur dark:border-citrus-night-border dark:bg-citrus-night-card/95">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              {editing === sel.id ? (
                <div className="flex flex-col gap-1.5">
                  <input
                    autoFocus
                    value={draft.label}
                    onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
                    placeholder="Event label"
                    className="w-full rounded border border-citrus-border bg-citrus-bg px-1.5 py-1 text-[12px] font-bold text-citrus-dark outline-none focus:border-citrus-pink/60 dark:border-citrus-night-border dark:bg-citrus-night-bg dark:text-citrus-night-text"
                  />
                  <input
                    value={draft.technique}
                    onChange={(e) => setDraft((d) => ({ ...d, technique: e.target.value }))}
                    placeholder="ATT&CK technique (T1059.001)"
                    className="w-full rounded border border-citrus-border bg-citrus-bg px-1.5 py-1 text-[11px] text-citrus-dark outline-none focus:border-citrus-pink/60 dark:border-citrus-night-border dark:bg-citrus-night-bg dark:text-citrus-night-text"
                  />
                  <input
                    value={draft.users}
                    onChange={(e) => setDraft((d) => ({ ...d, users: e.target.value }))}
                    placeholder="User accounts, comma-separated"
                    className="w-full rounded border border-citrus-border bg-citrus-bg px-1.5 py-1 text-[11px] text-citrus-dark outline-none focus:border-citrus-pink/60 dark:border-citrus-night-border dark:bg-citrus-night-bg dark:text-citrus-night-text"
                  />
                  <textarea
                    value={draft.description}
                    onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                    rows={2}
                    placeholder="Description"
                    className="w-full resize-y rounded border border-citrus-border bg-citrus-bg px-1.5 py-1 text-[11px] text-citrus-dark outline-none focus:border-citrus-pink/60 dark:border-citrus-night-border dark:bg-citrus-night-bg dark:text-citrus-night-text"
                  />
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-[12px] font-bold text-citrus-dark dark:text-citrus-night-text">{sel.label}</span>
                    {sel.actor === 'analyst' && (
                      <span
                        className="shrink-0 rounded-full border border-emerald-500/50 px-1.5 text-[9px] font-bold uppercase tracking-wide text-emerald-600 dark:text-emerald-400"
                        title="Analyst-authored — protected from AI edits"
                      >
                        analyst
                      </span>
                    )}
                    {/* The host(s) this happened on. Without it, three genuinely distinct per-host
                        actions ("event logs cleared") read as duplicates of each other. Two hosts on
                        one event is not an error — a lateral movement has evidence at both ends. */}
                    {sel.hosts?.map((h) => (
                      <span
                        key={h}
                        className="shrink-0 rounded-full border border-citrus-border px-1.5 text-[9px] font-bold uppercase tracking-wide text-citrus-muted dark:border-citrus-night-border dark:text-citrus-night-muted"
                        title="Host this event's evidence came from"
                      >
                        {h}
                      </span>
                    ))}
                  </div>
                  {/* A contested reading must not render like a settled one. This is the whole point
                      of the field: a memory-dump tool that ran in an attacker window but sat on disk
                      a week early looked identical to a DCSync until it could say so. */}
                  {sel.uncertainty && (
                    <div className="mt-1 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-1 text-[10px] leading-snug text-amber-700 dark:text-amber-400">
                      <span className="font-bold uppercase tracking-wide">Unsettled — </span>
                      {sel.uncertainty}
                    </div>
                  )}
                  {sel.technique && (
                    <span className="mt-0.5 inline-block rounded-full bg-citrus-pink/10 px-1.5 py-0.5 text-[10px] font-semibold text-citrus-pink">{sel.technique}</span>
                  )}
                  {sel.users && sel.users.length > 0 && (
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      {sel.users.map((u) => (
                        <span
                          key={u}
                          className="inline-flex items-center gap-1 rounded-full bg-citrus-dark/5 px-1.5 py-0.5 text-[10px] font-medium text-citrus-dark dark:bg-citrus-night-text/10 dark:text-citrus-night-text"
                          title="User account this event involves"
                        >
                          <User className="h-2.5 w-2.5" /> {u}
                        </span>
                      ))}
                    </div>
                  )}
                  {sel.description && <div className="mt-1 text-[11px] text-citrus-muted dark:text-citrus-night-muted">{sel.description}</div>}
                  {(() => {
                    const { min, max } = eventSpan(sel)
                    if (min == null) return <div className="mt-1 text-[10px] italic text-citrus-muted dark:text-citrus-night-muted">undated</div>
                    return (
                      <div className="mt-1 inline-flex items-center gap-1 text-[10px] text-citrus-muted dark:text-citrus-night-muted">
                        <Clock className="w-3 h-3" /> {fmtFull(min)}
                        {max != null && max !== min ? ` → ${fmtFull(max)}` : ''} UTC
                      </div>
                    )
                  })()}
                </>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {editing === sel.id ? (
                <>
                  <button onClick={saveEdit} title="Save" className="text-citrus-muted hover:text-citrus-pink dark:text-citrus-night-muted">
                    <Check className="w-3.5 h-3.5" />
                  </button>
                  <button onClick={() => setEditing(null)} title="Cancel" className="text-citrus-muted hover:text-citrus-pink dark:text-citrus-night-muted">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </>
              ) : (
                <>
                  {onUpdate && (
                    <button onClick={() => beginEdit(sel)} title="Edit this event's interpretation" className="text-citrus-muted hover:text-citrus-pink dark:text-citrus-night-muted">
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                  )}
                  {onDelete &&
                    (confirmDelete === sel.id ? (
                      <button
                        onClick={() => {
                          onDelete(sel.id)
                          setConfirmDelete(null)
                          setSelected(null)
                        }}
                        className="rounded border border-red-500/60 px-1.5 py-0.5 text-[10px] font-bold text-red-600 dark:border-red-400/60 dark:text-red-400"
                      >
                        Remove?
                      </button>
                    ) : (
                      <button onClick={() => setConfirmDelete(sel.id)} title="Remove this event" className="text-citrus-muted hover:text-red-600 dark:text-citrus-night-muted">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    ))}
                </>
              )}
            </div>
          </div>
          <div className="mt-2 text-[10px] font-bold uppercase tracking-wide text-citrus-muted dark:text-citrus-night-muted">Corroborated by</div>
          <div className="mt-1 max-h-40 space-y-1 overflow-y-auto">
            {sel.evidence.map((e, i) => (
              <div key={e.id ?? i} className="group flex items-stretch gap-1">
                <button
                  onClick={() => onPivot(e.sourceId, e.rids)}
                  title={`Jump to ${e.rids.length} row(s) in ${e.sourceName}${e.why ? ` — ${e.why}` : ''}`}
                  className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-md border border-citrus-border px-2 py-1 text-left text-[11px] text-citrus-dark hover:border-citrus-pink/50 hover:text-citrus-pink dark:border-citrus-night-border dark:text-citrus-night-text"
                >
                  <span className="flex w-full items-center justify-between gap-2">
                    <span className="min-w-0 flex-1 truncate">
                      <span className="text-citrus-muted dark:text-citrus-night-muted">{e.sourceName}:</span>{' '}
                      <span className="font-mono">{e.matched || 'selected rows'}</span>
                    </span>
                    <span className="inline-flex shrink-0 items-center gap-1 text-citrus-muted dark:text-citrus-night-muted">
                      {e.rids.length < e.count ? `${e.rids.length} of ${e.count.toLocaleString()}` : e.count.toLocaleString()}
                      <Crosshair className="w-3 h-3" />
                    </span>
                  </span>
                  {/* The agent's per-row rationale — why THIS row backs the event. */}
                  {e.why && <span className="w-full truncate text-[10px] italic text-citrus-muted dark:text-citrus-night-muted">{e.why}</span>}
                </button>
                {onDeleteEvidence && e.id != null && (
                  <button
                    onClick={() => onDeleteEvidence(e.id!)}
                    title="Remove this evidence"
                    className="shrink-0 rounded-md px-1 text-citrus-muted opacity-0 hover:text-red-500 group-hover:opacity-100 dark:text-citrus-night-muted"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {mode === 'iocs' &&
        selIoc &&
        (() => {
          const node = iocLayout.iocNodes.find((n) => n.ioc.id === selIoc)
          if (!node) return null
          const { ioc, eventIds } = node
          const linkedEvents = eventIds.map((id) => events.find((ev) => ev.id === id)).filter((ev): ev is CsvEvent => !!ev)
          return (
            <div className="absolute bottom-3 left-3 w-80 max-w-[85%] rounded-lg border border-citrus-border bg-citrus-card/95 p-3 shadow-lg backdrop-blur dark:border-citrus-night-border dark:bg-citrus-night-card/95">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="break-all font-mono text-[12px] font-bold text-citrus-dark dark:text-citrus-night-text">{ioc.value}</div>
                  <div className="mt-0.5 flex items-center gap-1.5">
                    <span className="inline-block rounded-full bg-citrus-pink/10 px-1.5 py-0.5 text-[10px] font-semibold text-citrus-pink">{iocTypeLabel(ioc.type)}</span>
                    {ENRICHABLE.has(ioc.type) && onSendToIntel && (
                      <button
                        onClick={() => onSendToIntel([ioc.value])}
                        title="Send to the Intel grid"
                        className="inline-flex items-center gap-1 rounded border border-citrus-border px-1.5 py-0.5 text-[10px] font-semibold text-citrus-dark hover:border-citrus-pink/40 hover:text-citrus-pink dark:border-citrus-night-border dark:text-citrus-night-text"
                      >
                        <Radar className="h-3 w-3" /> Send to Intel
                      </button>
                    )}
                  </div>
                  {ioc.context && <div className="mt-1 text-[11px] text-citrus-muted dark:text-citrus-night-muted">{ioc.context}</div>}
                </div>
                <button onClick={() => setSelIoc(null)} title="Close" className="shrink-0 text-citrus-muted hover:text-citrus-pink dark:text-citrus-night-muted">
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="mt-2 text-[10px] font-bold uppercase tracking-wide text-citrus-muted dark:text-citrus-night-muted">
                {linkedEvents.length > 0 ? `Appears in ${linkedEvents.length} event${linkedEvents.length === 1 ? '' : 's'}` : 'Not found in any recorded event'}
              </div>
              {linkedEvents.length > 0 && (
                <div className="mt-1 max-h-40 space-y-1 overflow-y-auto">
                  {linkedEvents.map((ev) => (
                    <button
                      key={ev.id}
                      onClick={() => {
                        setSelIoc(null)
                        setSelected(ev.id)
                      }}
                      title="Show this event's evidence"
                      className="flex w-full items-center gap-1.5 rounded-md border border-citrus-border px-2 py-1 text-left text-[11px] text-citrus-dark hover:border-citrus-pink/50 hover:text-citrus-pink dark:border-citrus-night-border dark:text-citrus-night-text"
                    >
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: ev.technique ? '#ec4899' : '#f59e0b' }} />
                      <span className="min-w-0 flex-1 truncate">{ev.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )
        })()}
    </div>
  )
}
