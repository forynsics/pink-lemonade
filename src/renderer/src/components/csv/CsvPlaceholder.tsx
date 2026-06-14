import { FolderOpen, Table2 } from 'lucide-react'
import type { CsvDoc } from '../../state/documents'

// Shown for a CSV tab restored from a previous session: the temp .db is gone, so the
// file must be re-opened to repopulate it.

export function CsvPlaceholder({
  doc,
  onReopen
}: {
  doc: CsvDoc
  onReopen: () => void
}): JSX.Element {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center bg-citrus-card dark:bg-citrus-night-card">
      <Table2 className="w-10 h-10 text-citrus-pink/60" />
      <div className="text-sm font-bold text-citrus-dark dark:text-citrus-night-text">{doc.sourceName}</div>
      <p className="max-w-xs text-xs text-citrus-muted dark:text-citrus-night-muted">
        This CSV tab was restored from your last session. The data isn’t kept on disk between runs —
        re-open the file to load it back into the viewer.
      </p>
      <button
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-bold bg-citrus-pink text-white hover:bg-citrus-pink-hover transition-colors"
        onClick={onReopen}
      >
        <FolderOpen className="w-3.5 h-3.5" /> Re-open file…
      </button>
    </div>
  )
}
