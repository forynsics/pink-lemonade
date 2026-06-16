---
title: Exploring data
nav_order: 5
---

# Exploring data

Once you’ve imported a file into a [workspace](workspaces.md), you get a fast, spreadsheet-style
grid built for big timelines — it stays smooth on millions of rows. Here’s how to dig in.

## The grid

- **Scroll** freely; rows load as you go.
- **Sort** by clicking a column header — click again to flip ascending/descending, a third time to
  clear it.
- **Resize a column** by dragging its right edge; **double-click** the edge to auto-fit it to the
  widest value.
- **Reorder columns** by dragging a header left or right. The order is remembered.
- **Show or hide columns** with the **Columns** button in the header (or a header’s ▾ →
  **Hide column**) — handy for taming wide timelines. Your choice is remembered, and hidden columns
  are left out of exports.
- **Time columns** are detected automatically and marked with a 🕐 clock icon.
- **Copy** a selection of cells (click-drag to select, or click a row number for the whole row)
  with **Ctrl+C** — it copies as tab-separated values, ready to paste into a spreadsheet.

The header shows the column count and the live row count, e.g. `3 cols · 1,204,377 rows`.

## Search

The search box filters the grid to rows that contain your term, highlights the matches, and shows
**“k of N”**. Press **Enter** to jump to the next match (Shift+Enter for the previous). It’s great
for “does this host/IP/hash appear anywhere?”

## Filters

Filters narrow the grid to exactly the rows you care about. Active filters appear as **chips** —
click a chip to edit it, or its ✕ to remove it.

**From a cell (right-click):**
- **Filter to value** — keep only rows where this column equals this value.
- **Exclude value** — drop rows with this value.

**From the column menu (the ▾ on a header):**
- **Filter** opens a checklist of the column’s distinct values — tick several to keep *any* of them
  (a multi-value filter, shown as `column ∈ a, b, c`).

**Operators available:** contains, not contains, equals, ≠ (exclude), and — on time columns —
on/after (≥), on/before (≤), and between.

> On a huge file, building a filter that needs the column’s value list shows your current picks
> instantly and only scans for the full list when you ask (or start typing to search values).

## Distinct values

From a column’s ▾ menu, choose **Distinct values** to open a side panel listing every unique value
and how many times it occurs — perfect for “what signatures/hosts/levels are in here?”

On a large file the scan runs in the background with a **live progress** readout and a **Cancel**
button, so the app never freezes. You can **export** the distinct values (or *all* values) into a
new notepad to run them through text tools.

## Time pivots — “show me ±N around this”

Investigations live and die on timelines. Right-click a **timestamp cell** and pick a window — e.g.
**± 5 minutes** (or type a custom amount) — to filter the whole source to events around that moment.

Crucially, **you don’t lose your place**: the row you pivoted from keeps a pink **ring and a 📍 pin**
and the grid re-centers on it, so you can immediately see what happened just before and after.

You can also set one-sided time bounds (on/after, on/before) from the same menu; combine them for a
custom “between” window.

## Exporting the view

The **Export CSV** button writes the **current view** — every row under your active
filters / search / sort, and only the **visible columns** in their on-screen order — to a CSV file.
The confirm dialog shows how many rows will be written, and the whole match set is streamed to disk,
not just the rows on screen.

## Next

→ [Tagging rows](tagging.md) to mark what you find, then [Intel Sweep](intel-sweep.md) to hunt for
known indicators across the source.
