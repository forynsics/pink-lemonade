---
title: AI assistant
nav_order: 9
---

# AI assistant

pink-lemonade has a built-in **AI analyst assistant** — Claude, embedded in the app and pointed at the
workspace you have open. It helps you triage and reason about your data: it searches your sources,
correlates across them and over time, reads the intel cache, and records what it concludes into the
same review surfaces you use by hand.

Its defining rule is that it is **grounded**. The assistant has *no* reliable knowledge of any specific
IP, domain, hash, or row from its own training — to learn anything concrete it must call the app's real
tools (the SQL layer, the intel cache, the classifiers). So it behaves like an analyst operating the
app, not a chatbot guessing from memory. If a question can't be answered from the tools, it says so.

Open it from the **Assistant** button in the top bar, then ask about the data you have open.

## Setup — it uses *your* Claude subscription

The assistant runs on **your own Claude Code login** — your Claude subscription — so:

- **No API key.** You don't paste an Anthropic API key anywhere. This is *not* the Anthropic API; it's
  the same login you use for Claude Code on the command line.
- **You need Claude Code installed and signed in.** Install it (see
  [claude.com/claude-code](https://claude.com/claude-code)) and run `claude` once in a terminal to sign
  in. pink-lemonade finds your installed `claude` and runs it — it does **not** bundle a copy.
- If a run fails with a login/not-found error, open a terminal and run `claude` to sign in, then retry.

Pick which Claude **model** to use in the assistant's settings (the ⚙️ pane). That's the only setting —
there's nothing else to configure.

## What it can do

While it investigates, the assistant works across your whole workspace, not just the source on screen:

- **Reads your sources** — lists them, inspects their columns, searches for values (smart containment,
  not just exact match), pulls distinct values, and reads small artifacts in full.
- **Investigates across sources and hosts** — finds where a value occurs across every loaded source in
  one shot, then drills in; respects [source groups](workspaces.md) (host/system) so a multi-host case
  stays straight.
- **Correlates by time** — lines up an event's traces across artifacts within a ±N-second window.
- **Reads the intel cache** — looks up what it already knows about an indicator (no quota cost). It does
  **not** spend fresh VirusTotal/MaxMind lookups on its own — that stays your call.

Anything that **changes your data** is gated: when the assistant wants to tag rows or (re)group a
source, it surfaces an **approval card** with the exact count, and nothing happens until you approve.

## What it produces — your review surfaces

The assistant doesn't just chat; it writes its findings into structured, clickable surfaces you can
review and pivot from. Toggle each from the workspace header:

- **✨ Marks** — as it makes a claim, it marks the exact rows that back it up (with a short note of
  why). Filter the grid to just the AI-marked rows to see precisely the evidence it cited.
- **Artifact Constellation** — the case graph. Each node is an **event** (a TTP it concluded happened —
  "Defender disabled", "AnyDesk installed", an encoded PowerShell run), corroborated by the specific
  rows across artifacts that prove it. It grounds each event against the data before recording it, and
  can attribute a MITRE ATT&CK technique and the user account(s) involved. Views: a graph, a **time
  axis**, and an **IOCs** view linking indicators to the events they appear in. Click any event to
  pivot straight to its evidence rows.
- **Timeline** — a curated, chronological super-timeline built from the recorded events
  (Time · Type · Source · Host · User · Description), sortable/filterable, exportable to l2t_csv-style
  CSV. Click a row to jump to its evidence; you can also **build it as a grid source** and, in that
  grid, double-click a row to pivot to the same evidence.
- **IOC catalog** — the indicators it has cataloged, grouped by type. Cataloging an IOC never sends it
  anywhere; sending an indicator to the Intel grid stays your decision.
- **Investigation plan** — a living plan (leads, each to-do / active / done) plus a short progress note.
  Both persist in the workspace and are shown back to the assistant at the start of the next session, so
  a long investigation resumes instead of restarting. You can read and edit them too.

A batch of work stops at a step limit with **Continue** offered — findings are already saved, so a long
investigation runs across several human-checked batches rather than one runaway loop.

## Where your data goes

To reason over your investigation, the assistant sends the **workspace data it reads** (rows, columns,
and cached intel it queries) to **Claude, through your own Claude Code login**. That's the only place it
goes, and it happens only while a run is active. There's no separate pink-lemonade account or server —
it's your subscription, your machine, your `claude`.

## Next

→ [Workspaces](workspaces.md) and [Exploring data](exploring-data.md) — the data the assistant operates
on
→ [Intel & watchlists](intel.md) — the enrichment cache it reads from
