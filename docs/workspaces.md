---
title: Workspaces
nav_order: 4
---

# Workspaces

A **workspace** is a self-contained investigation. It holds one or more imported files (called
**sources**) plus everything you build on them — tags, [sightings](intel-sweep.md), and the
[AI assistant](ai.md)'s findings (events, IOCs, and its investigation plan) — in a single `.workspace`
file on disk. Think of it as “the case I’m working on,” which you can close and reopen later exactly
where you left off.

## Creating a workspace

A few ways:

- **Import CSV / TSV…** (from Home or the sidebar) creates a workspace with that file as its first
  source. **Excel** workbooks (`.xlsx` / `.xlsm`) work too — each non-empty worksheet becomes a source.
- **Import folder…** points at a folder (e.g. a parsed KAPE package) and brings in **every** CSV / TSV
  / Excel file under it at once — you pick which to include, and can group them on the way in.
- **New workspace** creates an empty one; import files into it afterward.

## Sources (imported files)

A workspace can hold several files. The **left sidebar** lists them under **Imported files**, each
with its row count. Click one to view it; the active source is highlighted.

- **Import** (the dashed button in the sidebar) adds another file to the current workspace.
- **Rename a source** — double-click its name (or the ✏️ pencil) to give it a friendlier label.
  This only changes the display name; the data is untouched.
- **Remove a source** — the ✕ on a source row drops it from the workspace (after a confirm).

Each source is independent — it can have completely different columns from the others.

## Grouping sources by host / system

When a case spans several machines, give each source a **group** — the host / system / origin it came
from (e.g. `DESKTOP6`, `PaloAlto-Perimeter`). Set it from a source's **Layers** icon, on a multi-selected
set (ctrl/shift-click → **Group…**), or at folder-import time. The sidebar then lists sources under
group headers. Groups keep a multi-host investigation straight — and the AI assistant uses them to scope
its reasoning and attribute findings to the right system.

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
→ [Intel Sweep](intel-sweep.md) to hunt a source for known indicators
