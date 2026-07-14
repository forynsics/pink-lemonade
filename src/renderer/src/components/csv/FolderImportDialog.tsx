import { useMemo, useState } from 'react'
import { FolderInput, Layers, Search } from 'lucide-react'

export interface FolderFile {
  path: string
  sourceName: string
  relPath: string
  size: number
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

// Review-before-import: after picking a folder, the analyst confirms exactly which CSVs to ingest
// (a KAPE package has many, and you often want to skip the giant ones). All checked by default.
export function FolderImportDialog({
  folderName,
  files,
  existingPaths,
  onConfirm,
  onCancel
}: {
  folderName: string
  files: FolderFile[]
  /** Paths already imported into the target workspace — pre-unchecked + badged to avoid duplicates. */
  existingPaths?: Set<string>
  onConfirm: (selected: FolderFile[], group: string | null) => void
  onCancel: () => void
}): JSX.Element {
  // Start with already-imported files excluded (you can still opt them back in).
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set(files.filter((f) => existingPaths?.has(f.path)).map((f) => f.path)))
  const [filter, setFilter] = useState('')
  // Optional: assign every imported file to one group (the host/system the package came from).
  const [group, setGroup] = useState('')
  const dupes = existingPaths ? files.filter((f) => existingPaths.has(f.path)).length : 0

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return q ? files.filter((f) => f.relPath.toLowerCase().includes(q)) : files
  }, [files, filter])

  const selectedCount = files.length - excluded.size
  const totalSize = files.reduce((a, f) => (excluded.has(f.path) ? a : a + f.size), 0)

  const toggle = (path: string): void =>
    setExcluded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  const setAll = (on: boolean): void => setExcluded(on ? new Set() : new Set(files.map((f) => f.path)))

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onCancel}>
      <div
        className="flex max-h-[80vh] w-[40rem] max-w-[92vw] flex-col rounded-xl border border-citrus-border bg-citrus-card shadow-lg dark:border-citrus-night-border dark:bg-citrus-night-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-citrus-border px-4 py-3 dark:border-citrus-night-border">
          <FolderInput className="w-4 h-4 text-citrus-pink shrink-0" />
          <div className="min-w-0">
            <div className="text-sm font-bold text-citrus-dark dark:text-citrus-night-text">
              Import from “{folderName}”
            </div>
            <div className="text-[11px] text-citrus-muted dark:text-citrus-night-muted">
              {files.length} file{files.length === 1 ? '' : 's'} found — choose which to import.
              {dupes > 0 && <span className="text-citrus-pink"> {dupes} already imported (unchecked).</span>}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 border-b border-citrus-border/60 px-4 py-2 dark:border-citrus-night-border/60">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2 top-1.5 w-3.5 h-3.5 text-citrus-muted dark:text-citrus-night-muted" />
            <input
              className="w-full rounded-md border border-citrus-border bg-citrus-bg pl-7 pr-2 py-1 text-[12px] text-citrus-dark outline-none focus:border-citrus-pink/60 dark:border-citrus-night-border dark:bg-citrus-night-bg dark:text-citrus-night-text"
              placeholder="Filter by path…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
          <button onClick={() => setAll(true)} className="rounded-md border border-citrus-border px-2 py-1 text-[11px] font-semibold text-citrus-muted hover:text-citrus-pink dark:border-citrus-night-border dark:text-citrus-night-muted">
            All
          </button>
          <button onClick={() => setAll(false)} className="rounded-md border border-citrus-border px-2 py-1 text-[11px] font-semibold text-citrus-muted hover:text-citrus-pink dark:border-citrus-night-border dark:text-citrus-night-muted">
            None
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
          {shown.length === 0 && <div className="px-2 py-6 text-center text-[12px] text-citrus-muted dark:text-citrus-night-muted">No files match the filter.</div>}
          {shown.map((f) => {
            const on = !excluded.has(f.path)
            return (
              <label key={f.path} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-[12px] hover:bg-citrus-sand/50 dark:hover:bg-citrus-night-elev">
                <input type="checkbox" checked={on} onChange={() => toggle(f.path)} className="accent-citrus-pink" />
                <span className="min-w-0 flex-1 truncate font-mono text-citrus-dark dark:text-citrus-night-text" title={f.relPath}>
                  {f.relPath}
                </span>
                {existingPaths?.has(f.path) && (
                  <span className="shrink-0 rounded-full bg-citrus-pink/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-citrus-pink">imported</span>
                )}
                <span className="shrink-0 font-mono text-[11px] text-citrus-muted dark:text-citrus-night-muted">{fmtSize(f.size)}</span>
              </label>
            )
          })}
        </div>

        <div className="flex items-center gap-2 border-t border-citrus-border/60 px-4 py-2 dark:border-citrus-night-border/60">
          <Layers className="w-3.5 h-3.5 shrink-0 text-citrus-muted dark:text-citrus-night-muted" />
          <input
            className="flex-1 rounded-md border border-citrus-border bg-citrus-bg px-2 py-1 text-[12px] text-citrus-dark outline-none focus:border-citrus-pink/60 dark:border-citrus-night-border dark:bg-citrus-night-bg dark:text-citrus-night-text"
            placeholder="Group these as… (e.g. DESKTOP-YYZ32C)"
            value={group}
            onChange={(e) => setGroup(e.target.value)}
          />
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-citrus-border px-4 py-3 dark:border-citrus-night-border">
          <div className="text-[11px] text-citrus-muted dark:text-citrus-night-muted">
            {selectedCount} selected · {fmtSize(totalSize)}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={onCancel} className="rounded-md border border-citrus-border px-3 py-1 text-[11px] font-bold text-citrus-dark hover:bg-citrus-sand/60 dark:border-citrus-night-border dark:text-citrus-night-text dark:hover:bg-citrus-night-elev">
              Cancel
            </button>
            <button
              onClick={() => onConfirm(files.filter((f) => !excluded.has(f.path)), group.trim() || null)}
              disabled={selectedCount === 0}
              className="rounded-md bg-citrus-pink px-3 py-1 text-[11px] font-bold text-white hover:bg-citrus-pink-hover disabled:opacity-40"
            >
              Import {selectedCount} file{selectedCount === 1 ? '' : 's'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
