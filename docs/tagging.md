---
title: Tagging
nav_order: 6
---

# Tagging

As you work through a source, you’ll want to mark rows: this one’s malicious, that one’s benign,
this needs a second look. pink-lemonade lets you **tag rows** and then **filter by those tags** —
and your tags are saved in the workspace, so they’re still there next time.

## The four tags

Every tag is one of four triage levels, each with its own color:

- 🔴 **Malicious**
- 🟠 **Suspicious**
- ⚪ **Unknown**
- 🟢 **Benign**

A row has at most one tag.

## Tagging rows

**One row:** right-click a cell → **Tag row as** → pick a level (or **Clear tag**).

**Several rows:** select them first (click a row number, then Shift-click another to select a range),
then right-click and choose **Tag N rows as…**. The same menu offers **Clear tags** for the selection.

**Everything matching a filter (bulk):** when a filter or search is active, a **“Tag N matching ▾”**
button appears in the header. This tags *every* row that matches your current view in one go — not
just the rows on screen. That’s the way to tag, say, all 12,000 events from a known-bad IP across a
multi-GB timeline. The same menu can **clear** tags on the matching rows.

## Seeing your tags

Tagged rows are easy to spot:

- a **colored bar** on the left edge of the row, and
- a **faint tint** across the whole row in the tag’s color — so you can still tell a row is malicious
  even when you’ve scrolled far to the right and the marker is off-screen.

## Filtering by tag

The **Tags** section in the left sidebar lists each tag you’ve used with a count, under a
**“click to filter”** hint. Click a tag to show only those rows. Click **more than one** to show
rows with *any* of them (e.g. Malicious **or** Suspicious). Click again to toggle one off, or use
**Clear tag filters** to drop them all. The active tag filter also shows as a chip in the filter bar.

## It’s saved

Tags are stored inside the workspace file, keyed to each row. Close the app, reopen the workspace,
and your tags — and the colored markers, counts, and filters — are exactly as you left them.

## A typical flow

1. Filter or search to a suspicious indicator (an IP, a signature, a host).
2. **Tag N matching** as Malicious to mark the whole set at once.
3. Pivot ±15 minutes around a key event to see the blast radius, tagging Suspicious/Benign as you go.
4. Later, click the **Malicious** facet in the sidebar to review everything you flagged.
