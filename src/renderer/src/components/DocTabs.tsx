import { useEffect, useRef, useState } from 'react'
import { Plus, X, Home, NotebookPen, FolderOpen } from 'lucide-react'
import type { PinkDoc } from '../state/documents'

export function DocTabs({
  docs,
  activeId,
  home,
  onHome,
  onSelect,
  onAdd,
  onClose,
  onRename
}: {
  docs: PinkDoc[]
  activeId: string
  home: boolean
  onHome: () => void
  onSelect: (id: string) => void
  onAdd: () => void
  onClose: (id: string) => void
  onRename: (id: string, name: string) => void
}): JSX.Element {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editingId) inputRef.current?.select()
  }, [editingId])

  function startRename(doc: PinkDoc): void {
    setEditingId(doc.id)
    setDraft(doc.name)
  }

  function commit(): void {
    if (editingId) onRename(editingId, draft.trim() || 'Untitled')
    setEditingId(null)
  }

  return (
    <div className="flex items-center gap-1 px-3 pt-2 border-b border-citrus-border bg-citrus-sand/60 dark:border-citrus-night-border dark:bg-citrus-night">
      <button
        className={`tabs__home mb-0.5 p-1.5 rounded-full transition-colors ${
          home
            ? 'text-citrus-pink bg-citrus-card dark:bg-citrus-night-card'
            : 'text-citrus-muted hover:text-citrus-pink hover:bg-citrus-card dark:text-citrus-night-muted dark:hover:bg-citrus-night-card'
        }`}
        onClick={onHome}
        title="Home / recent files"
      >
        <Home className="w-4 h-4" />
      </button>
      <div className="flex items-center gap-1 overflow-x-auto scrollbar-none">
        {docs.map((doc) => {
          const isActive = doc.id === activeId
          const isEditing = doc.id === editingId
          return (
            <div
              key={doc.id}
              className={`tab group flex items-center gap-2 px-3 py-2 rounded-t-lg text-xs font-semibold cursor-pointer border-t border-l border-r transition-colors ${
                isActive
                  ? 'tab--active bg-citrus-card text-citrus-dark border-citrus-border shadow-sm dark:bg-citrus-night-card dark:text-citrus-night-text dark:border-citrus-night-border'
                  : 'bg-transparent text-citrus-muted border-transparent hover:bg-citrus-card/60 dark:text-citrus-night-muted dark:hover:bg-citrus-night-card/50'
              }`}
              onClick={() => onSelect(doc.id)}
              onDoubleClick={() => startRename(doc)}
              title="Double-click to rename"
            >
              {isEditing ? (
                <input
                  ref={inputRef}
                  className="bg-transparent outline-none text-xs font-semibold w-28 text-citrus-dark dark:text-citrus-night-text"
                  value={draft}
                  autoFocus
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={commit}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commit()
                    if (e.key === 'Escape') setEditingId(null)
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <>
                  {doc.kind === 'workspace' ? (
                    <FolderOpen className="w-3 h-3 text-citrus-pink shrink-0" />
                  ) : (
                    <NotebookPen className="w-3 h-3 text-citrus-pink shrink-0" />
                  )}
                  <span className="truncate max-w-[140px]">{doc.name}</span>
                  <button
                    className="text-citrus-muted hover:text-citrus-pink rounded-full p-0.5 opacity-60 group-hover:opacity-100 transition-opacity dark:text-citrus-night-muted"
                    onClick={(e) => {
                      e.stopPropagation()
                      onClose(doc.id)
                    }}
                    title="Close document"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </>
              )}
            </div>
          )
        })}
      </div>
      <button
        className="tabs__add p-1.5 rounded-full text-citrus-muted hover:text-citrus-pink hover:bg-citrus-card transition-colors dark:text-citrus-night-muted dark:hover:bg-citrus-night-card"
        onClick={onAdd}
        title="New notepad"
      >
        <Plus className="w-4 h-4" />
      </button>
    </div>
  )
}
