# pink-lemonade

**A local, offline desktop toolkit for cybersecurity investigation and data wrangling.**

pink-lemonade is a “swiss-army knife” for the messy middle of an investigation: pulling
indicators out of a blob of text, cleaning up exports, and pivoting through big CSV/TSV
timelines (Splunk exports, plaso timelines, EVTX dumps, firewall logs) — all without
leaving your machine or pasting sensitive data into an online tool.

Everything runs **100% locally**. There is no server, no account, and no network calls —
so it’s safe for sensitive or air-gapped work.

---

## The two things it does

pink-lemonade has two modes, and you move between them with tabs:

### 📝 Notepad — text transforms
Paste in a chunk of text and run it through a chain of small tools: decode Base64, extract
IPv4 addresses and other IOCs, defang/refang indicators, dedupe lines, fix whitespace and
case, and more. Each tool feeds the next, so you build a little pipeline and watch the output
update live.

→ [Notepad guide](notepad.md)

### 🗂️ Workspaces — data investigation
Import one or more CSV/TSV files into a **workspace** and explore them in a fast spreadsheet-style
grid that scales to millions of rows. Sort, filter, search, pull distinct values, pivot around a
timestamp, and **tag rows** (Malicious / Suspicious / Unknown / Benign) as you triage — with your
tags saved for next time.

→ [Workspaces guide](workspaces.md) · [Exploring data](exploring-data.md) · [Tagging](tagging.md)

---

## Guide

1. [Getting started](getting-started.md) — the Home screen and your first notepad / import
2. [Notepad](notepad.md) — text tools and chaining them into a workflow
3. [Workspaces](workspaces.md) — importing data, sources, and managing workspace files
4. [Exploring data](exploring-data.md) — sorting, searching, filtering, distinct values, time pivots
5. [Tagging](tagging.md) — triaging rows and filtering by tag

---

## Good to know

- **Local & offline.** No data ever leaves your computer.
- **It remembers your work.** Open tabs and workspaces (with their tags) come back when you relaunch.
- **Built for big files.** The grid stays responsive on multi-GB timelines; heavy operations show a
  spinner with progress and can be canceled.
