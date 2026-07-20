import { useEffect, useMemo, useState, type ChangeEvent, type KeyboardEvent, type MouseEvent } from 'react'
import { CheckSquare, ChevronDown, ChevronRight, Database, FileText, FolderOpen, FolderInput, Filter, Layers, Loader2, Pencil, Plus, Radar, Square, X } from 'lucide-react'
import type { WorkspaceDoc, WorkspaceSource } from '../../state/documents'
import { TAG_DEFS, type TagId } from '../../state/tags'
import type { TagSummary } from './CsvViewer'

/** Compact row count, e.g. 2,901,233 → "2.9M". */
function fmtRows(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${Math.round(n / 1000)}k`
  return String(n)
}

// Collapsed groups, remembered PER WORKSPACE — a case's shape is stable across sessions, so which
// hosts you keep folded is worth persisting. With several hosts imported the flat list is a wall of
// filenames and you cannot see at a glance which machines are even in the case; folding a host answers
// that in one look.
const groupsKey = (wsId: string): string => `pink-lemonade:groups-collapsed:${wsId}`

function loadCollapsed(wsId: string): Set<string> {
  try {
    const raw = localStorage.getItem(groupsKey(wsId))
    const arr = raw ? (JSON.parse(raw) as unknown) : null
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set() // a locked-down profile can throw; never break the sidebar over a preference
  }
}

const SIDEBAR_W_KEY = 'pink-lemonade:sidebar-w'
const W_MIN = 200
const W_MAX = 560
const clampW = (w: number): number => Math.min(W_MAX, Math.max(W_MIN, Math.round(w)))

// Inline edit target: the workspace name, or a source's display name / grouping label.
type EditTarget = { t: 'ws' } | { t: 'name'; id: number } | { t: 'group'; id: number }

// The contextual left rail when a workspace tab is active (swaps in for the Tool Palette):
// the workspace name, its imported files (sources, grouped by host/system), and an Import action.
// The rail is drag-resizable (long KAPE/Hayabusa filenames) and its width persists.
export function WorkspaceSidebar({
  doc,
  importing,
  onSelectSource,
  onImport,
  onImportFolder,
  onRemoveSource,
  onRename,
  onRenameSource,
  onSetSourceGroup,
  onSetSourceGroupMany,
  tagSummary,
  onToggleTagFilter,
  onExcludeTagFilter,
  onClearTagFilter,
  intelMode,
  onSetIntelMode,
  onOpenIntel
}: {
  doc: WorkspaceDoc
  importing: boolean
  onSelectSource: (sourceId: number) => void
  onImport: () => void
  onImportFolder: () => void
  onRemoveSource: (sourceId: number) => void
  /** Rename the workspace (persists to its db). */
  onRename: (name: string) => void
  /** Rename a source's display label. */
  onRenameSource: (sourceId: number, name: string) => void
  /** Set (or clear, with null) a source's grouping label — the host/system/origin it belongs to. */
  onSetSourceGroup: (sourceId: number, group: string | null) => void
  /** Set (or clear) the group on several sources at once (multi-select → "Group selected…"). */
  onSetSourceGroupMany: (sourceIds: number[], group: string | null) => void
  /** Tag rollup for the active source (counts + the active tag filter set), reported by its viewer. */
  tagSummary?: TagSummary | null
  onToggleTagFilter?: (tag: TagId) => void
  onExcludeTagFilter?: (tag: TagId) => void
  onClearTagFilter?: () => void
  /** Which intel this workspace uses + controls to switch / open it. */
  intelMode: 'global' | 'workspace'
  onSetIntelMode: (mode: 'global' | 'workspace') => void
  onOpenIntel: () => void
}): JSX.Element {
  const activeTags = tagSummary?.activeTags ?? []
  const excludedTags = tagSummary?.excludedTags ?? []
  // Show a facet if it has matches OR is currently part of a filter (so an excluded tag stays visible
  // even when the predicate drops its visible count to 0).
  const tagRows = TAG_DEFS.filter(
    (d) => tagSummary?.counts[d.id] || activeTags.includes(d.id) || excludedTags.includes(d.id)
  )

  // Resizable width (persisted). Drag the right edge.
  const [width, setWidth] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem(SIDEBAR_W_KEY))
      if (Number.isFinite(v) && v >= W_MIN && v <= W_MAX) return v
    } catch {
      /* ignore */
    }
    return 240
  })
  function startResize(e: MouseEvent): void {
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    let last = startW
    const move = (ev: globalThis.MouseEvent): void => {
      last = clampW(startW + ev.clientX - startX)
      setWidth(last)
    }
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      try {
        localStorage.setItem(SIDEBAR_W_KEY, String(last))
      } catch {
        /* ignore */
      }
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  // Sources grouped by their label, in first-appearance order, with the ungrouped bucket (null) last.
  // Headers only render when at least one source is grouped — an all-ungrouped workspace stays a flat list.
  const grouped = useMemo(() => {
    const order: Array<string | null> = []
    const m = new Map<string | null, WorkspaceSource[]>()
    for (const s of doc.sources) {
      const g = s.group ?? null
      if (!m.has(g)) {
        m.set(g, [])
        order.push(g)
      }
      m.get(g)!.push(s)
    }
    order.sort((a, b) => (a === null ? 1 : b === null ? -1 : 0))
    return order.map((g) => ({ group: g, sources: m.get(g)! }))
  }, [doc.sources])
  const hasGroups = doc.sources.some((s) => s.group)
  // Re-read when the workspace changes so each case keeps its own folded set.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsed(doc.wsId))
  useEffect(() => setCollapsed(loadCollapsed(doc.wsId)), [doc.wsId])
  const persistCollapsed = (next: Set<string>): void => {
    setCollapsed(next)
    try {
      localStorage.setItem(groupsKey(doc.wsId), JSON.stringify([...next]))
    } catch {
      /* persistence is a convenience; never block the toggle */
    }
  }
  const groupKeyOf = (g: string | null): string => g ?? '__ungrouped'
  const toggleGroup = (g: string | null): void => {
    const k = groupKeyOf(g)
    const next = new Set(collapsed)
    next.has(k) ? next.delete(k) : next.add(k)
    persistCollapsed(next)
  }
  const allCollapsed = grouped.length > 0 && grouped.every((g) => collapsed.has(groupKeyOf(g.group)))
  const toggleAll = (): void =>
    persistCollapsed(allCollapsed ? new Set() : new Set(grouped.map((g) => groupKeyOf(g.group))))

  // Source ids in the order they actually render (grouped or flat) — the basis for shift-range select.
  const visualIds = useMemo(
    () =>
      hasGroups
        ? grouped.filter((g) => !collapsed.has(g.group ?? '__ungrouped')).flatMap((g) => g.sources.map((s) => s.sourceId))
        : doc.sources.map((s) => s.sourceId),
    [grouped, hasGroups, doc.sources, collapsed]
  )

  // Multi-select: ctrl/cmd-click toggles a source, shift-click selects a range, plain click opens it
  // (and clears the selection). When ≥1 selected, an action bar can group them all at once.
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [anchor, setAnchor] = useState<number | null>(null)
  const [groupingMany, setGroupingMany] = useState(false)
  const [manyDraft, setManyDraft] = useState('')
  function clearSelection(): void {
    setSelected(new Set())
    setGroupingMany(false)
  }
  function onRowClick(e: MouseEvent, sourceId: number): void {
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault()
      setSelected((prev) => {
        const n = new Set(prev)
        if (n.has(sourceId)) n.delete(sourceId)
        else n.add(sourceId)
        return n
      })
      setAnchor(sourceId)
      return
    }
    if (e.shiftKey && anchor != null) {
      e.preventDefault()
      const a = visualIds.indexOf(anchor)
      const b = visualIds.indexOf(sourceId)
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a]
        setSelected(new Set(visualIds.slice(lo, hi + 1)))
      }
      return
    }
    clearSelection()
    setAnchor(sourceId)
    onSelectSource(sourceId)
  }
  // Checkbox toggle — additive (builds a selection without opening the source); shift extends the range.
  function toggleSelect(e: MouseEvent, sourceId: number): void {
    e.stopPropagation()
    if (e.shiftKey && anchor != null) {
      const a = visualIds.indexOf(anchor)
      const b = visualIds.indexOf(sourceId)
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a]
        setSelected((prev) => {
          const n = new Set(prev)
          for (const id of visualIds.slice(lo, hi + 1)) n.add(id)
          return n
        })
      }
    } else {
      setSelected((prev) => {
        const n = new Set(prev)
        if (n.has(sourceId)) n.delete(sourceId)
        else n.add(sourceId)
        return n
      })
    }
    setAnchor(sourceId)
  }
  // The per-row group icon: when a multi-selection is active, group the WHOLE selection (adding this
  // row if it isn't in it yet); otherwise inline-edit just this source's group.
  function onRowGroupClick(sourceId: number): void {
    if (selected.size > 0) {
      if (!selected.has(sourceId)) setSelected((prev) => new Set(prev).add(sourceId))
      setGroupingMany(true)
    } else {
      const s = doc.sources.find((x) => x.sourceId === sourceId)
      startEdit({ t: 'group', id: sourceId }, s?.group ?? '')
    }
  }
  function commitMany(): void {
    onSetSourceGroupMany([...selected], manyDraft.trim() || null)
    setManyDraft('')
    clearSelection()
  }

  // Inline rename/group edit. null = not editing.
  const [editing, setEditing] = useState<EditTarget | null>(null)
  const [draft, setDraft] = useState('')
  function startEdit(target: EditTarget, current: string): void {
    setEditing(target)
    setDraft(current)
  }
  function commit(): void {
    if (!editing) return
    const v = draft.trim()
    if (editing.t === 'group') onSetSourceGroup(editing.id, v || null) // empty clears the group
    else if (v) {
      if (editing.t === 'ws') onRename(v)
      else onRenameSource(editing.id, v)
    }
    setEditing(null)
  }
  const editCls =
    'min-w-0 flex-1 bg-transparent outline-none border-b border-citrus-pink/60 text-citrus-dark dark:text-citrus-night-text'
  const editProps = {
    autoFocus: true,
    value: draft,
    onChange: (e: ChangeEvent<HTMLInputElement>) => setDraft(e.target.value),
    onBlur: commit,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === 'Enter') commit()
      if (e.key === 'Escape') setEditing(null)
    },
    onClick: (e: MouseEvent) => e.stopPropagation()
  }

  function sourceRow(s: WorkspaceSource): JSX.Element {
    const active = s.sourceId === doc.activeSourceId
    const isSelected = selected.has(s.sourceId)
    const editingName = editing?.t === 'name' && editing.id === s.sourceId
    const editingGroup = editing?.t === 'group' && editing.id === s.sourceId
    return (
      <div
        key={s.sourceId}
        className={`group flex items-center rounded-md text-xs transition-colors ${
          isSelected ? 'ring-1 ring-inset ring-citrus-pink/70 ' : ''
        }${
          active
            ? 'bg-citrus-pink-light font-bold text-citrus-pink'
            : isSelected
              ? 'bg-citrus-pink/10 text-citrus-dark dark:text-citrus-night-text'
              : 'text-citrus-dark hover:bg-citrus-card/70 dark:text-citrus-night-text dark:hover:bg-citrus-night-elev'
        }`}
      >
        {editingName || editingGroup ? (
          <div className="flex flex-1 min-w-0 items-center gap-2 px-2 py-1.5">
            {editingGroup ? <Layers className="w-3.5 h-3.5 shrink-0 opacity-70" /> : <FileText className="w-3.5 h-3.5 shrink-0 opacity-70" />}
            <input {...editProps} placeholder={editingGroup ? 'Group…' : ''} className={editCls} />
          </div>
        ) : (
          <>
            <button
              onClick={(e) => toggleSelect(e, s.sourceId)}
              title="Shift-click for a range, then Group"
              className={`shrink-0 pl-1.5 py-1.5 ${selected.size > 0 || isSelected ? '' : 'opacity-0 group-hover:opacity-100'} ${isSelected ? 'text-citrus-pink' : 'text-citrus-muted dark:text-citrus-night-muted'} hover:text-citrus-pink`}
            >
              {isSelected ? <CheckSquare className="w-3.5 h-3.5" /> : <Square className="w-3.5 h-3.5" />}
            </button>
            <button
              onClick={(e) => onRowClick(e, s.sourceId)}
              onDoubleClick={() => startEdit({ t: 'name', id: s.sourceId }, s.name)}
              title={`${s.name} · double-click to rename`}
              className="flex flex-1 min-w-0 items-center gap-2 px-1.5 py-1.5 text-left"
            >
              <FileText className="w-3.5 h-3.5 shrink-0 opacity-70" />
              <span className="flex-1 truncate">{s.name}</span>
              <span className={`text-[10px] font-mono ${active ? 'text-citrus-pink' : 'text-citrus-muted dark:text-citrus-night-muted'}`}>
                {fmtRows(s.rowCount)}
              </span>
            </button>
            <button
              onClick={() => onRowGroupClick(s.sourceId)}
              title={
                selected.size > 0
                  ? `Group the ${selected.has(s.sourceId) ? selected.size : selected.size + 1} selected source(s)`
                  : s.group
                    ? `Group: ${s.group} — click to change`
                    : 'Assign a group'
              }
              className={`shrink-0 px-1 py-1.5 hover:text-citrus-pink ${
                s.group || selected.size > 0 ? 'text-citrus-pink/70' : 'text-citrus-muted opacity-0 group-hover:opacity-100 dark:text-citrus-night-muted'
              }`}
            >
              <Layers className="w-3 h-3" />
            </button>
            <button
              onClick={() => startEdit({ t: 'name', id: s.sourceId }, s.name)}
              title="Rename source"
              className="shrink-0 px-1 py-1.5 text-citrus-muted opacity-0 group-hover:opacity-100 hover:text-citrus-pink dark:text-citrus-night-muted"
            >
              <Pencil className="w-3 h-3" />
            </button>
            <button
              onClick={() => onRemoveSource(s.sourceId)}
              title="Remove from workspace"
              className="shrink-0 px-1.5 py-1.5 text-citrus-muted opacity-0 group-hover:opacity-100 hover:text-citrus-pink dark:text-citrus-night-muted"
            >
              <X className="w-3 h-3" />
            </button>
          </>
        )}
      </div>
    )
  }

  return (
    <div className="workspace-sidebar relative flex shrink-0" style={{ width }}>
      <aside className="flex flex-1 min-w-0 flex-col gap-4 overflow-y-auto border-r border-citrus-border bg-citrus-sand/40 p-3 dark:border-citrus-night-border dark:bg-citrus-night">
        <div className="group flex items-center gap-2 px-1 text-sm font-bold text-citrus-dark dark:text-citrus-night-text">
          <FolderOpen className="w-4 h-4 text-citrus-pink shrink-0" />
          {editing?.t === 'ws' ? (
            <input {...editProps} className={editCls} />
          ) : (
            <>
              <span className="truncate cursor-text" title="Double-click to rename" onDoubleClick={() => startEdit({ t: 'ws' }, doc.name)}>
                {doc.name}
              </span>
              <button
                onClick={() => startEdit({ t: 'ws' }, doc.name)}
                title="Rename workspace"
                className="shrink-0 text-citrus-muted opacity-0 group-hover:opacity-100 hover:text-citrus-pink dark:text-citrus-night-muted"
              >
                <Pencil className="w-3 h-3" />
              </button>
            </>
          )}
        </div>

        <div>
          <div className="px-1 mb-1.5 flex items-center gap-2 text-[10px] font-bold uppercase tracking-wide text-citrus-muted dark:text-citrus-night-muted">
            <span className="flex-1">Imported files</span>
            {hasGroups && grouped.length > 1 && (
              <button
                onClick={toggleAll}
                title={allCollapsed ? 'Expand every group' : 'Collapse every group — the fastest way to see which hosts are in this case'}
                className="normal-case tracking-normal font-semibold hover:text-citrus-pink"
              >
                {allCollapsed ? 'Expand all' : 'Collapse all'}
              </button>
            )}
          </div>
          {selected.size > 0 && (
            <div className="mb-1.5 rounded-md border border-citrus-pink/40 bg-citrus-pink/5 px-2 py-1.5 text-[11px]">
              {groupingMany ? (
                <div className="flex items-center gap-1.5">
                  <Layers className="w-3 h-3 shrink-0 text-citrus-pink" />
                  <input
                    autoFocus
                    value={manyDraft}
                    placeholder={`Group ${selected.size} as…`}
                    onChange={(e) => setManyDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitMany()
                      if (e.key === 'Escape') setGroupingMany(false)
                    }}
                    className={editCls}
                  />
                  <button onClick={commitMany} title="Apply group" className="shrink-0 font-bold text-citrus-pink hover:underline">
                    Set
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="flex-1 font-semibold text-citrus-pink">{selected.size} selected</span>
                  <button onClick={() => setGroupingMany(true)} className="font-bold text-citrus-pink hover:underline">
                    Group…
                  </button>
                  <button
                    onClick={() => {
                      onSetSourceGroupMany([...selected], null)
                      clearSelection()
                    }}
                    title="Remove these from their group"
                    className="text-citrus-muted hover:text-citrus-pink dark:text-citrus-night-muted"
                  >
                    Ungroup
                  </button>
                  <button onClick={clearSelection} className="text-citrus-muted hover:text-citrus-pink dark:text-citrus-night-muted">
                    Clear
                  </button>
                </div>
              )}
            </div>
          )}
          <div className="flex flex-col gap-0.5">
            {doc.sources.length === 0 && (
              <div className="px-2 py-1.5 text-[11px] text-citrus-muted dark:text-citrus-night-muted">
                No sources yet — import a CSV.
              </div>
            )}
            {hasGroups
              ? grouped.map(({ group, sources }) => {
                  const isCollapsed = collapsed.has(groupKeyOf(group))
                  // A folded group that holds the OPEN file gets a dot, so the sidebar never loses
                  // track of where the file on screen actually lives.
                  const holdsActive = sources.some((s) => s.sourceId === doc.activeSourceId)
                  return (
                    <div key={group ?? '__ungrouped'} className="mb-1">
                      <button
                        onClick={() => toggleGroup(group)}
                        title={isCollapsed ? `Expand ${group ?? 'Ungrouped'}` : `Collapse ${group ?? 'Ungrouped'}`}
                        className="w-full px-1 mb-0.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-citrus-muted/80 hover:text-citrus-pink dark:text-citrus-night-muted/80"
                      >
                        {isCollapsed ? <ChevronRight className="w-2.5 h-2.5 shrink-0" /> : <ChevronDown className="w-2.5 h-2.5 shrink-0" />}
                        <Layers className="w-2.5 h-2.5 shrink-0" />
                        <span className="flex-1 truncate text-left normal-case tracking-normal font-bold" title={group ?? 'Ungrouped'}>
                          {group ?? 'Ungrouped'}
                        </span>
                        {isCollapsed && holdsActive && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-citrus-pink" title="The open file is in this group" />}
                        <span className="font-mono">{sources.length}</span>
                      </button>
                      {!isCollapsed && sources.map(sourceRow)}
                    </div>
                  )
                })
              : doc.sources.map(sourceRow)}
            <button
              onClick={onImport}
              disabled={importing}
              className="mt-1 flex items-center gap-2 rounded-md border border-dashed border-citrus-border px-2 py-1.5 text-xs font-semibold text-citrus-muted hover:border-citrus-pink/40 hover:text-citrus-pink disabled:opacity-60 dark:border-citrus-night-border dark:text-citrus-night-muted"
            >
              {importing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
              {importing ? 'Importing…' : 'Import file…'}
            </button>
            <button
              onClick={onImportFolder}
              disabled={importing}
              title="Import a folder of files"
              className="flex items-center gap-2 rounded-md border border-dashed border-citrus-border px-2 py-1.5 text-xs font-semibold text-citrus-muted hover:border-citrus-pink/40 hover:text-citrus-pink disabled:opacity-60 dark:border-citrus-night-border dark:text-citrus-night-muted"
            >
              <FolderInput className="w-3.5 h-3.5" />
              Import folder…
            </button>
          </div>
        </div>

        {tagRows.length > 0 && (
          <div className="workspace-sidebar__tags">
            <div className="px-1 mb-1.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-citrus-muted dark:text-citrus-night-muted">
              Tags
              <span className="font-normal normal-case tracking-normal text-citrus-muted/70 dark:text-citrus-night-muted/70">
                · click filter · right-click exclude
              </span>
            </div>
            <div className="flex flex-col gap-0.5">
              {tagRows.map((d) => {
                const active = activeTags.includes(d.id)
                const excluded = excludedTags.includes(d.id)
                return (
                  <button
                    key={d.id}
                    onClick={() => onToggleTagFilter?.(d.id)}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      onExcludeTagFilter?.(d.id)
                    }}
                    title={
                      excluded
                        ? `Excluding ${d.label} — right-click to clear`
                        : active
                          ? `Showing ${d.label} — left-click to clear`
                          : `Left-click to show only ${d.label} · right-click to exclude it`
                    }
                    className={`group flex items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors ${
                      active
                        ? 'bg-citrus-pink-light font-bold text-citrus-pink'
                        : excluded
                          ? 'bg-citrus-sand/60 text-citrus-muted dark:bg-citrus-night-elev/60 dark:text-citrus-night-muted'
                          : 'text-citrus-dark hover:bg-citrus-card/70 dark:text-citrus-night-text dark:hover:bg-citrus-night-elev'
                    }`}
                  >
                    <span className={`inline-block w-2.5 h-2.5 rounded-sm shrink-0 ${d.dot}`} />
                    <span className={`flex-1 text-left truncate ${excluded ? 'line-through' : ''}`}>{d.label}</span>
                    <span className={`font-mono ${active ? 'text-citrus-pink' : 'text-citrus-muted dark:text-citrus-night-muted'}`}>
                      {tagSummary?.counts[d.id] ?? 0}
                    </span>
                    <Filter
                      className={`w-3 h-3 shrink-0 ${active || excluded ? 'text-citrus-pink' : 'text-citrus-muted/0 group-hover:text-citrus-muted dark:group-hover:text-citrus-night-muted'}`}
                    />
                  </button>
                )
              })}
            </div>
            {(activeTags.length > 0 || excludedTags.length > 0) && (
              <button
                onClick={() => onClearTagFilter?.()}
                className="mt-1 px-2 text-[11px] text-citrus-muted hover:text-citrus-pink dark:text-citrus-night-muted"
              >
                ✕ Clear tag filter{activeTags.length + excludedTags.length > 1 ? 's' : ''}
              </button>
            )}
          </div>
        )}

        {/* Intel: which intel DB this workspace looks up against. */}
        <div className="workspace-sidebar__intel">
          <div className="px-1 mb-1.5 text-[10px] font-bold uppercase tracking-wide text-citrus-muted dark:text-citrus-night-muted">
            Intel
          </div>
          <button
            onClick={onOpenIntel}
            title="Open this workspace's intel tab"
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-citrus-dark hover:bg-citrus-card/70 dark:text-citrus-night-text dark:hover:bg-citrus-night-elev"
          >
            <Radar className="w-3.5 h-3.5 shrink-0 text-citrus-pink" />
            <span className="flex-1 text-left truncate">{intelMode === 'workspace' ? 'Workspace Intel' : 'Global Intel'}</span>
            <FolderOpen className="w-3 h-3 shrink-0 text-citrus-muted dark:text-citrus-night-muted" />
          </button>
          <button
            onClick={() => onSetIntelMode(intelMode === 'workspace' ? 'global' : 'workspace')}
            className="mt-0.5 px-2 text-[11px] text-citrus-muted hover:text-citrus-pink dark:text-citrus-night-muted"
            title={
              intelMode === 'workspace'
                ? 'Switch this workspace back to Global Intel'
                : 'Give this workspace its own Workspace Intel (a separate file)'
            }
          >
            {intelMode === 'workspace' ? 'Use Global Intel instead' : 'Use a Workspace Intel'}
          </button>
        </div>

        <div className="mt-auto flex items-start gap-1.5 border-t border-citrus-border/60 pt-2 text-[10px] font-mono text-citrus-muted/70 dark:border-citrus-night-border/60 dark:text-citrus-night-muted/70 break-all">
          <Database className="w-3 h-3 mt-px shrink-0" />
          <span>{doc.dbPath}</span>
        </div>
      </aside>
      <div
        onMouseDown={startResize}
        title="Drag to resize"
        className="absolute right-0 top-0 h-full w-1.5 -mr-0.5 cursor-col-resize hover:bg-citrus-pink/40"
      />
    </div>
  )
}
