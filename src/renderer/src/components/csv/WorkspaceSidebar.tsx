import { useState, type ChangeEvent, type KeyboardEvent, type MouseEvent } from 'react'
import { FileText, FolderOpen, Filter, Loader2, Pencil, Plus, X } from 'lucide-react'
import type { WorkspaceDoc } from '../../state/documents'
import { TAG_DEFS, type TagId } from '../../state/tags'
import type { TagSummary } from './CsvViewer'

/** Compact row count, e.g. 2,901,233 → "2.9M". */
function fmtRows(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${Math.round(n / 1000)}k`
  return String(n)
}

// The contextual left rail when a workspace tab is active (swaps in for the Tool Palette):
// the workspace name, its imported files (sources), and an Import action.
export function WorkspaceSidebar({
  doc,
  importing,
  onSelectSource,
  onImport,
  onRemoveSource,
  onRename,
  onRenameSource,
  tagSummary,
  onToggleTagFilter,
  onClearTagFilter
}: {
  doc: WorkspaceDoc
  importing: boolean
  onSelectSource: (sourceId: number) => void
  onImport: () => void
  onRemoveSource: (sourceId: number) => void
  /** Rename the workspace (persists to its db). */
  onRename: (name: string) => void
  /** Rename a source's display label. */
  onRenameSource: (sourceId: number, name: string) => void
  /** Tag rollup for the active source (counts + the active tag filter set), reported by its viewer. */
  tagSummary?: TagSummary | null
  onToggleTagFilter?: (tag: TagId) => void
  onClearTagFilter?: () => void
}): JSX.Element {
  const tagRows = TAG_DEFS.filter((d) => tagSummary?.counts[d.id])
  const activeTags = tagSummary?.activeTags ?? []

  // Inline rename: 'ws' = the workspace name, a number = that source id, null = not editing.
  const [editing, setEditing] = useState<'ws' | number | null>(null)
  const [draft, setDraft] = useState('')
  function startEdit(target: 'ws' | number, current: string): void {
    setEditing(target)
    setDraft(current)
  }
  function commit(): void {
    const v = draft.trim()
    if (v) {
      if (editing === 'ws') onRename(v)
      else if (typeof editing === 'number') onRenameSource(editing, v)
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
  return (
    <aside className="workspace-sidebar flex w-60 shrink-0 flex-col gap-4 overflow-y-auto border-r border-citrus-border bg-citrus-sand/40 p-3 dark:border-citrus-night-border dark:bg-citrus-night">
      <div className="group flex items-center gap-2 px-1 text-sm font-bold text-citrus-dark dark:text-citrus-night-text">
        <FolderOpen className="w-4 h-4 text-citrus-pink shrink-0" />
        {editing === 'ws' ? (
          <input {...editProps} className={editCls} />
        ) : (
          <>
            <span className="truncate cursor-text" title="Double-click to rename" onDoubleClick={() => startEdit('ws', doc.name)}>
              {doc.name}
            </span>
            <button
              onClick={() => startEdit('ws', doc.name)}
              title="Rename workspace"
              className="shrink-0 text-citrus-muted opacity-0 group-hover:opacity-100 hover:text-citrus-pink dark:text-citrus-night-muted"
            >
              <Pencil className="w-3 h-3" />
            </button>
          </>
        )}
      </div>

      <div>
        <div className="px-1 mb-1.5 text-[10px] font-bold uppercase tracking-wide text-citrus-muted dark:text-citrus-night-muted">
          Imported files
        </div>
        <div className="flex flex-col gap-0.5">
          {doc.sources.length === 0 && (
            <div className="px-2 py-1.5 text-[11px] text-citrus-muted dark:text-citrus-night-muted">
              No sources yet — import a CSV.
            </div>
          )}
          {doc.sources.map((s) => {
            const active = s.sourceId === doc.activeSourceId
            return (
              <div
                key={s.sourceId}
                className={`group flex items-center rounded-md text-xs transition-colors ${
                  active
                    ? 'bg-citrus-pink-light font-bold text-citrus-pink'
                    : 'text-citrus-dark hover:bg-citrus-card/70 dark:text-citrus-night-text dark:hover:bg-citrus-night-elev'
                }`}
              >
                {editing === s.sourceId ? (
                  <div className="flex flex-1 min-w-0 items-center gap-2 px-2 py-1.5">
                    <FileText className="w-3.5 h-3.5 shrink-0 opacity-70" />
                    <input {...editProps} className={editCls} />
                  </div>
                ) : (
                  <>
                    <button
                      onClick={() => onSelectSource(s.sourceId)}
                      onDoubleClick={() => startEdit(s.sourceId, s.name)}
                      title="Double-click to rename · click to open"
                      className="flex flex-1 min-w-0 items-center gap-2 px-2 py-1.5 text-left"
                    >
                      <FileText className="w-3.5 h-3.5 shrink-0 opacity-70" />
                      <span className="flex-1 truncate">{s.name}</span>
                      <span
                        className={`text-[10px] font-mono ${active ? 'text-citrus-pink' : 'text-citrus-muted dark:text-citrus-night-muted'}`}
                      >
                        {fmtRows(s.rowCount)}
                      </span>
                    </button>
                    <button
                      onClick={() => startEdit(s.sourceId, s.name)}
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
          })}
          <button
            onClick={onImport}
            disabled={importing}
            className="mt-1 flex items-center gap-2 rounded-md border border-dashed border-citrus-border px-2 py-1.5 text-xs font-semibold text-citrus-muted hover:border-citrus-pink/40 hover:text-citrus-pink disabled:opacity-60 dark:border-citrus-night-border dark:text-citrus-night-muted"
          >
            {importing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
            {importing ? 'Importing…' : 'Import CSV / TSV…'}
          </button>
        </div>
      </div>

      {tagRows.length > 0 && (
        <div className="workspace-sidebar__tags">
          <div className="px-1 mb-1.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-citrus-muted dark:text-citrus-night-muted">
            Tags
            <span className="font-normal normal-case tracking-normal text-citrus-muted/70 dark:text-citrus-night-muted/70">
              · click to filter
            </span>
          </div>
          <div className="flex flex-col gap-0.5">
            {tagRows.map((d) => {
              const active = activeTags.includes(d.id)
              return (
                <button
                  key={d.id}
                  onClick={() => onToggleTagFilter?.(d.id)}
                  title={active ? `Showing ${d.label} only — click to clear` : `Show only ${d.label}`}
                  className={`group flex items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors ${
                    active
                      ? 'bg-citrus-pink-light font-bold text-citrus-pink'
                      : 'text-citrus-dark hover:bg-citrus-card/70 dark:text-citrus-night-text dark:hover:bg-citrus-night-elev'
                  }`}
                >
                  <span className={`inline-block w-2.5 h-2.5 rounded-sm shrink-0 ${d.dot}`} />
                  <span className="flex-1 text-left truncate">{d.label}</span>
                  <span className={`font-mono ${active ? 'text-citrus-pink' : 'text-citrus-muted dark:text-citrus-night-muted'}`}>
                    {tagSummary?.counts[d.id]}
                  </span>
                  <Filter
                    className={`w-3 h-3 shrink-0 ${active ? 'text-citrus-pink' : 'text-citrus-muted/0 group-hover:text-citrus-muted dark:group-hover:text-citrus-night-muted'}`}
                  />
                </button>
              )
            })}
          </div>
          {activeTags.length > 0 && (
            <button
              onClick={() => onClearTagFilter?.()}
              className="mt-1 px-2 text-[11px] text-citrus-muted hover:text-citrus-pink dark:text-citrus-night-muted"
            >
              ✕ Clear tag filter{activeTags.length > 1 ? 's' : ''}
            </button>
          )}
        </div>
      )}

      <div className="mt-auto border-t border-citrus-border/60 pt-2 text-[10px] font-mono text-citrus-muted/70 dark:border-citrus-night-border/60 dark:text-citrus-night-muted/70 break-all">
        💾 {doc.dbPath}
      </div>
    </aside>
  )
}
