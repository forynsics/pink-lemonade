# Workspaces

A **workspace** is a self-contained investigation. It holds one or more imported CSV/TSV files
(called **sources**) plus any tags you’ve applied — all in a single `.workspace` file on disk.
Think of it as “the case I’m working on,” which you can close and reopen later exactly where you
left off.

## Creating a workspace

Two ways:

- **Import CSV / TSV…** (from Home or the sidebar) creates a workspace with that file as its first
  source.
- **New workspace** creates an empty one; import files into it afterward.

## Sources (imported files)

A workspace can hold several files. The **left sidebar** lists them under **Imported files**, each
with its row count. Click one to view it; the active source is highlighted.

- **Import** (the dashed button in the sidebar) adds another file to the current workspace.
- **Rename a source** — double-click its name (or the ✏️ pencil) to give it a friendlier label.
  This only changes the display name; the data is untouched.
- **Remove a source** — the ✕ on a source row drops it from the workspace (after a confirm).

Each source is independent — it can have completely different columns from the others.

## Renaming the workspace

- **Double-click the tab**, or
- **Double-click the workspace name** at the top of the sidebar (or its ✏️ pencil).

The name is saved into the workspace file, so it sticks when you reopen it.

## Where workspaces are stored

The sidebar footer shows the **path to the workspace file** (next to a database icon). By default,
workspaces live in an app-managed folder, but you can change where they’re kept:

> On the Home screen, the **Workspace folder** row shows the current location with a **Change…**
> button. New workspaces save there, and the *Open workspace…* dialog starts there.

## Closing and reopening

Workspaces persist automatically. When you relaunch the app, your workspace tabs are still there —
**click the tab to resume** it (it reconnects to its file). You can also reopen one from the
**Recent workspaces** list on Home, or with **Open workspace…** if you saved it somewhere custom.

## Next

→ [Exploring the data](exploring-data.md) in a source
→ [Tagging rows](tagging.md) as you triage
