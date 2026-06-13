import { useEffect, useRef, useState } from 'react'
import type { PinkDoc } from '../state/documents'

export function DocTabs({
  docs,
  activeId,
  onSelect,
  onAdd,
  onClose,
  onRename
}: {
  docs: PinkDoc[]
  activeId: string
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
    <div className="tabs">
      <div className="tabs__list">
        {docs.map((doc) => {
          const isActive = doc.id === activeId
          const isEditing = doc.id === editingId
          return (
            <div
              key={doc.id}
              className={`tab${isActive ? ' tab--active' : ''}`}
              onClick={() => onSelect(doc.id)}
              onDoubleClick={() => startRename(doc)}
              title="Double-click to rename"
            >
              {isEditing ? (
                <input
                  ref={inputRef}
                  className="tab__edit"
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
                  <span className="tab__name">{doc.name}</span>
                  <button
                    className="tab__close"
                    onClick={(e) => {
                      e.stopPropagation()
                      onClose(doc.id)
                    }}
                    title="Close document"
                  >
                    ✕
                  </button>
                </>
              )}
            </div>
          )
        })}
      </div>
      <button className="tabs__add" onClick={onAdd} title="New document">
        ＋
      </button>
    </div>
  )
}
