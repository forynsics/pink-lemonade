# 🍋 pink-lemonade

**A desktop toolkit for cybersecurity investigation and data wrangling.**

pink-lemonade handles the messy middle of an investigation — the parsing, cleanup, and
pivoting you do between your bigger tools: pull indicators out of text, clean up exports, and
work through big CSV/TSV timelines (Splunk exports, plaso timelines, EVTX dumps, firewall
logs), all in one place instead of juggling Notepad++ and a stack of single-purpose tools.

Built with **Electron + React + TypeScript**. Online enrichment (threat-intel lookups, an
AI assistant) is on the roadmap.

---

## What it does

**📝 Notepad — text transforms.** Paste text and run it through a chain of small tools:
Base64/hex decode, IPv4 & IOC extraction, defang/refang, dedupe lines, whitespace/case
cleanup. Each tool feeds the next, so you build a pipeline and watch the output update live.
Per-pane find (Ctrl+F) with highlight-and-step.

**🗂️ Workspaces — data investigation.** Import one or more CSV/TSV files into a workspace
and explore them in a fast, virtualized grid that scales to millions of rows / multi-GB files:

- **Sort, resize, reorder columns**; search with highlight + step.
- **Filters**: contains / not-contains / equals / ≠, multi-value (`∈`), and time ranges.
- **Distinct values** panel with live progress + cancel; export values to a notepad.
- **Time pivots** — right-click a timestamp → ±N window, keeping your anchor row in view.
- **Tagging** — mark rows Malicious / Suspicious / Unknown / Benign (single, multi-row, or
  bulk-by-filter), see colored markers, and filter by one or more tags. Tags persist in the
  workspace file across restarts.

The database runs in a worker thread, so even heavy operations never freeze the UI.

→ **User guide:** [`docs/`](docs/README.md)

---

## Quick start

Requirements: **Node.js 18+** and npm.

```bash
git clone <repo-url>
cd pink-lemonade
npm install
npm run dev          # launch the app with hot reload
```

## Scripts

```bash
npm run dev          # dev server + Electron window (HMR)
npm test             # unit tests (Vitest)
npm run typecheck    # type-check main/preload + renderer
npm run build        # production bundle to out/
npm run dist         # build + package a Windows NSIS installer (.exe) into dist/
```

> Packaging (`npm run dist`) targets Windows (NSIS). Run it on Windows (or a suitable
> cross-build environment). The installer is written to `dist/` and is **not** committed —
> distribute it via a GitHub Release rather than the repo.

---

## Project layout

```
src/
  main/        Electron main process — window + IPC; the DB runs in a worker thread
    csv/       SQLite-backed CSV/workspace engine (db.ts, worker.ts, sql.ts, …)
  preload/     contextBridge surface exposed to the renderer (window.api)
  renderer/    React UI (tools palette, notepad, CSV grid, workspace sidebar)
    src/tools/ the text-transform tool registry (pure functions)
docs/          user guide
```

The renderer is sandboxed (no Node access); all file/DB work happens in the main process
over a small IPC surface.

---

## License

_TODO: add a license before publishing._
