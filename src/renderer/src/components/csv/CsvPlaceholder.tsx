import { Loader2, RefreshCw, Table2 } from 'lucide-react'

// Shown for a workspace tab restored from a previous session while its persistent db is being
// re-opened by path. Normally a brief flash; if the db file is missing it shows an error.

export function CsvPlaceholder({
  name,
  dbPath,
  failed,
  onReopen
}: {
  name: string
  dbPath?: string
  failed?: boolean
  onReopen: () => void
}): JSX.Element {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center bg-citrus-card dark:bg-citrus-night-card">
      <Table2 className="w-10 h-10 text-citrus-pink/60" />
      <div className="text-sm font-bold text-citrus-dark dark:text-citrus-night-text">{name}</div>
      {failed ? (
        <>
          <p className="max-w-xs text-xs text-citrus-muted dark:text-citrus-night-muted">
            This workspace’s database couldn’t be opened — it may have moved or been deleted.
          </p>
          {dbPath && (
            <p className="max-w-md text-[10px] font-mono text-citrus-muted/70 dark:text-citrus-night-muted/70 truncate">
              {dbPath}
            </p>
          )}
          <button
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-bold bg-citrus-pink text-white hover:bg-citrus-pink-hover transition-colors"
            onClick={onReopen}
          >
            <RefreshCw className="w-3.5 h-3.5" /> Try again
          </button>
        </>
      ) : (
        <div className="inline-flex items-center gap-1.5 text-xs text-citrus-muted dark:text-citrus-night-muted">
          <Loader2 className="w-3.5 h-3.5 animate-spin text-citrus-pink" /> Resuming session…
        </div>
      )}
    </div>
  )
}
