import { NotebookPen, FolderPlus, FolderOpen, Clock, Plus, X, HardDrive, Radar } from 'lucide-react'
import { Logo } from './Logo'
import type { RecentFile } from '../state/recent'

// First-run / home screen: the primary entry points (new notepad, new workspace, import CSV, open
// workspace) plus a list of recent workspaces. Shown via the Home button or on first launch.
// `recent` entries now describe workspaces — path = the .workspace db path, sourceName = its name.

function ago(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

function Action({
  onClick,
  icon,
  title,
  sub,
  cls
}: {
  onClick: () => void
  icon: JSX.Element
  title: string
  sub: string
  cls: string
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`${cls} flex items-center gap-3 px-4 py-3 rounded-xl border border-citrus-border bg-citrus-card text-left hover:border-citrus-pink/50 hover:shadow-sm transition dark:border-citrus-night-border dark:bg-citrus-night-card`}
    >
      {icon}
      <span>
        <span className="block text-sm font-bold text-citrus-dark dark:text-citrus-night-text">{title}</span>
        <span className="block text-[11px] text-citrus-muted dark:text-citrus-night-muted">{sub}</span>
      </span>
    </button>
  )
}

export function Welcome({
  recent,
  onOpenRecent,
  onNewWorkspace,
  onImportCsv,
  onOpenWorkspace,
  onNewScratch,
  onNewEnrichment,
  workspaceDir,
  onChangeWorkspaceDir,
  onRemoveRecent,
  onClearRecent
}: {
  recent: RecentFile[]
  onOpenRecent: (f: RecentFile) => void
  onNewWorkspace: () => void
  onImportCsv: () => void
  onOpenWorkspace: () => void
  onNewScratch: () => void
  onNewEnrichment: () => void
  /** Where workspaces are stored + the Open-Workspace dialog default. */
  workspaceDir: string
  onChangeWorkspaceDir: () => void
  onRemoveRecent: (path: string) => void
  onClearRecent: () => void
}): JSX.Element {
  const ico = 'w-5 h-5 text-citrus-pink shrink-0'
  return (
    <div className="welcome flex-1 min-h-0 overflow-auto bg-citrus-cream/40 dark:bg-citrus-night">
      <div className="mx-auto max-w-2xl px-8 py-12">
        <div className="flex items-center gap-3 mb-1">
          <Logo />
          <span className="text-2xl font-bold tracking-tight text-citrus-dark dark:text-citrus-night-text">
            pink<span className="text-citrus-pink">lemonade</span>
          </span>
        </div>
        <p className="text-sm text-citrus-muted dark:text-citrus-night-muted mb-8">
          Local investigation toolkit — parse, pivot, and triage all in one space.
        </p>

        <div className="grid grid-cols-2 gap-3 mb-10">
          <Action cls="welcome__import-csv" onClick={onImportCsv} icon={<Plus className={ico} />} title="Import CSV / TSV…" sub="Pull a file into a workspace as a source" />
          <Action cls="welcome__new-workspace" onClick={onNewWorkspace} icon={<FolderPlus className={ico} />} title="New workspace" sub="Start an empty investigation" />
          <Action cls="welcome__open-workspace" onClick={onOpenWorkspace} icon={<FolderOpen className={ico} />} title="Open workspace…" sub="Open an existing .workspace file" />
          <Action cls="welcome__new" onClick={onNewScratch} icon={<NotebookPen className={ico} />} title="New notepad" sub="Text transforms + workflow" />
          <Action cls="welcome__new-enrichment" onClick={onNewEnrichment} icon={<Radar className={ico} />} title="Global Intel" sub="Bulk-look-up IPs / domains / hashes" />
        </div>

        <div className="welcome__ws-dir mb-10 flex items-center gap-2 rounded-lg border border-citrus-border/70 bg-citrus-card/50 px-3 py-2 text-[11px] dark:border-citrus-night-border/70 dark:bg-citrus-night-card/40">
          <HardDrive className="w-3.5 h-3.5 shrink-0 text-citrus-muted dark:text-citrus-night-muted" />
          <span className="shrink-0 text-citrus-muted dark:text-citrus-night-muted">Workspace folder</span>
          <span className="min-w-0 flex-1 truncate font-mono text-citrus-dark dark:text-citrus-night-text" title={workspaceDir}>
            {workspaceDir || '…'}
          </span>
          <button
            onClick={onChangeWorkspaceDir}
            className="welcome__change-dir shrink-0 rounded-md border border-citrus-border px-2 py-0.5 font-semibold text-citrus-muted hover:border-citrus-pink/40 hover:text-citrus-pink dark:border-citrus-night-border dark:text-citrus-night-muted"
          >
            Change…
          </button>
        </div>

        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-citrus-muted dark:text-citrus-night-muted">
            <Clock className="w-3.5 h-3.5" /> Recent workspaces
          </div>
          {recent.length > 0 && (
            <button
              onClick={onClearRecent}
              className="text-[11px] text-citrus-muted hover:text-citrus-pink dark:text-citrus-night-muted"
            >
              Clear
            </button>
          )}
        </div>

        {recent.length === 0 ? (
          <div className="rounded-xl border border-dashed border-citrus-border px-4 py-8 text-center text-xs text-citrus-muted dark:border-citrus-night-border dark:text-citrus-night-muted">
            No recent workspaces yet — import a CSV or create a workspace to see it here.
          </div>
        ) : (
          <ul className="flex flex-col gap-1">
            {recent.map((f) => (
              <li key={f.path} className="group flex items-center gap-2">
                <button
                  onClick={() => onOpenRecent(f)}
                  className="welcome__recent flex-1 flex items-center gap-3 px-3 py-2 rounded-lg border border-transparent hover:border-citrus-border hover:bg-citrus-card text-left transition dark:hover:border-citrus-night-border dark:hover:bg-citrus-night-card"
                  title={f.path}
                >
                  <FolderOpen className="w-4 h-4 text-citrus-pink shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs font-semibold text-citrus-dark truncate dark:text-citrus-night-text">{f.sourceName}</span>
                    <span className="block text-[10px] font-mono text-citrus-muted truncate dark:text-citrus-night-muted">{f.path}</span>
                  </span>
                  <span className="shrink-0 text-[10px] font-mono text-citrus-muted dark:text-citrus-night-muted">
                    {f.rowCount.toLocaleString()} rows · {ago(f.openedAt)}
                  </span>
                </button>
                <button
                  onClick={() => onRemoveRecent(f.path)}
                  className="shrink-0 p-1 rounded text-citrus-muted opacity-0 group-hover:opacity-100 hover:text-citrus-pink transition dark:text-citrus-night-muted"
                  title="Remove from recent"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
