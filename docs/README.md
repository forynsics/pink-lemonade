---
title: Home
nav_order: 1
permalink: /
---

<p align="center">
  <img src="assets/logo.png" alt="pink-lemonade" width="96" />
</p>

# pink-lemonade — user guide

**A desktop toolkit for cybersecurity investigation and data wrangling.**

pink-lemonade handles the messy middle of an investigation — the parsing, cleanup, and
pivoting you do between your bigger tools: pull indicators out of a blob of text, clean up
exports, work through big CSV/TSV timelines (Splunk exports, plaso timelines, EVTX dumps,
firewall logs), and hunt them for known indicators — all in one place instead of juggling
Notepad++ and a stack of single-purpose tools.

---

## The modes

You move between modes with tabs (and the Home button takes you back to the launcher).

### 📝 Notepad — text transforms
Paste a chunk of text and run it through a chain of small tools: decode Base64, extract IPv4
addresses and other IOCs, defang/refang indicators, dedupe lines, fix whitespace and case, build
SIEM queries (CQL / KQL / SPL), and more. Each tool feeds the next, so you build a little pipeline
and watch the output update live.

→ [Notepad guide](notepad.md)

### 🗂️ Workspaces — data investigation
Import one or more CSV/TSV files into a **workspace** and explore them in a fast spreadsheet-style
grid that scales to millions of rows. Sort, filter, search, show/hide columns, pull distinct
values, pivot around a timestamp, and **tag rows** (Malicious / Suspicious / Unknown / Benign) as
you triage — with your tags saved for next time.

→ [Workspaces guide](workspaces.md) · [Exploring data](exploring-data.md) · [Tagging](tagging.md)

### 🎯 Intel Sweep — hunt for known indicators
Sweep a workspace source for a known intel set — paste a list, load a saved **watchlist**, or open
a `.txt`/`.csv` — and mark each matching row as a **sighting**. Then roll the sightings up by
indicator, zero in, exclude, or clear false positives.

→ [Intel Sweep guide](intel-sweep.md)

### 🌐 Intel / Enrichment — context lookups
Look up indicators (IPs / domains / hashes) against providers — **MaxMind GeoIP** (a local database)
and **VirusTotal** (your own key, with a colored malicious/clean verdict) — into a sortable Intel
grid backed by an app-wide cache, and curate **watchlists** for context. Send values to Intel from
anywhere, and pivot the other way: sweep a workspace for the indicators you're looking at — or for
everything VirusTotal flagged malicious.

→ [Intel & watchlists guide](intel.md)

### 🤖 AI assistant — a grounded Claude analyst
An embedded **Claude** analyst that operates the workspace you have open — it searches your sources,
correlates across them and over time, and records what it concludes into clickable review surfaces (an
event **constellation**, a **timeline**, an IOC catalog, an investigation plan). It's **grounded**: it
uses the app's real tools for every fact instead of guessing. It runs on **your own Claude Code login**
(your Claude subscription) — no API key.

→ [AI assistant guide](ai.md)

---

## Guide

1. [Getting started](getting-started.md) — the Home screen and your first notepad / import
2. [Notepad](notepad.md) — text tools and chaining them into a workflow
3. [Workspaces](workspaces.md) — importing data, sources, and managing workspace files
4. [Exploring data](exploring-data.md) — sorting, searching, filtering, columns, distinct, time pivots
5. [Tagging](tagging.md) — triaging rows and filtering by tag
6. [Intel Sweep](intel-sweep.md) — sweeping a source for known indicators → sightings
7. [Intel & watchlists](intel.md) — enrichment lookups, watchlists, and the sweep pivot
8. [AI assistant](ai.md) — the grounded Claude analyst, and what it records

---

## Good to know

- **Desktop app.** Your workspaces, tags, sightings, and watchlists are saved as local files on
  your machine (under `%APPDATA%\pink-lemonade`).
- **It remembers your work.** Open tabs and workspaces come back when you relaunch.
- **Built for big files.** The grid stays responsive on multi-GB timelines; heavy operations show
  a spinner with progress and can be canceled.
- **Local-first, network opt-in.** Your workspaces, tags, sightings, and watchlists live in local
  files. Outbound calls happen only when you trigger them: **enrichment lookups** against a provider
  you've configured, and the **AI assistant** (which reasons over your data via your own Claude Code
  login). Nothing else leaves your machine.
