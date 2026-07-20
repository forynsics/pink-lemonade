---
title: AI agent
nav_order: 9
---

# Driving pink-lemonade from an AI agent

pink-lemonade doesn't have a chatbot in it. Instead, the app **hosts a small server on your own
machine**, and you point **your own AI agent** at it from a terminal. The agent then works the case
you have open — it searches your sources, correlates across them and over time, reads the intel
cache, and records what it concludes into review panels inside the app.

You stay in the app. The agent works in a terminal beside it, and everything it finds shows up live
in the **Constellation**, **Timeline**, **Investigation**, **IOCs**, **Systems & Accounts**, and
**Case Report** panels — where you approve or reject it.

Today that agent is **Claude Code**. The connection is a standard MCP server, so other agents can
follow.

## Why it works this way

The agent has **no reliable knowledge of any specific IP, domain, hash, or row** from its own
training. To learn anything concrete about your case it has to call the app's real tools — the SQL
layer, the intel cache, the classifiers. So it behaves like an analyst operating the app, not a
chatbot guessing from memory. If a question can't be answered from the tools, it says so.

Several tools enforce this rather than trusting the agent:

- `record_event` **validates the corroborating rows** — evidence that matches nothing is refused.
- `record_negative` **runs the search itself** and refuses to record an "absence" if anything
  matches, naming the term that hit. An absence that matches rows is a discovery, not an absence.
- `query_sql` accepts a single read-only `SELECT` — writes, `ATTACH` and `PRAGMA` are rejected — and
  **every query is logged into the case** for you to read back.

## Setup

You need **Claude Code** installed and signed in — see
[claude.com/claude-code](https://claude.com/claude-code). pink-lemonade doesn't bundle a copy and
doesn't need an Anthropic API key; it's the same login you already use at the command line.

The local server **starts with the app** — there's no button to start it. The **Terminal** button in
the top bar carries a status dot: 🟢 running, 🟡 starting, 🔴 error.

1. **Open a workspace.** The agent drives whichever workspace tab you have focused, so there has to
   be one.
2. **Click Terminal** in the top bar. The *Drive from a terminal* dialog opens.
3. **Set up your terminal folder** — click **Set up here** to accept the default folder, or
   **Choose folder…** to pick your own. (These stay disabled until the server is running.)
4. **Run Claude Code there.** The dialog shows the exact command with a **Copy** button:

   ```
   cd "<your folder>" && claude
   ```

5. **Accept the trust prompt.** The first time, Claude Code asks whether you trust the folder —
   accept it, or the `pinklemonade` tools won't load.

Then just ask it to investigate. **Keep the app open while you work.**

> **If you want the agent to import evidence itself**, set an **Evidence folder** on the Home screen
> first. That folder is the only place it can read files from; until one is set, Home shows *"Not set
> — the AI agent cannot import evidence"* and the agent can only work with what you've already
> imported.

### What gets written into that folder

Setting up the folder writes four files. They're rewritten every time you run setup, so a rotated
token or an updated methodology propagates:

| File | What it's for |
|---|---|
| `.mcp.json` | Points Claude Code at the app — the URL and the access token. |
| `CLAUDE.md` | The investigation methodology the agent follows. |
| `.claude/settings.local.json` | Pre-approves the app's tools so ordinary reads don't prompt every call. |
| `.gitignore` | Keeps the first two out of any repo you create there. |

### About the token

The server listens on **`127.0.0.1` only** — never on your network — and every request must carry a
bearer token that lives in `.mcp.json`. The token stops *other programs on your machine* from
driving the app; it isn't the approval mechanism for you (that's Claude Code's own prompt, below).
The port is fixed so `.mcp.json` doesn't go stale between launches. If something else is holding it,
the dialog tells you so and you'll need to close whatever that is.

## What the agent can do

Roughly forty tools, across:

- **Orientation** — list the case's sources and their host groups, describe a source's columns, list
  files in your evidence folder, list other cases on the machine.
- **Search** — find a value in one source (whole-token for IPs and hashes, substring for domains),
  find it across *every* source at once, structured filtered queries, distinct values, group-and-count
  aggregation, and a read-only `SELECT`.
- **Time correlation** — pull rows within ±N seconds of a timestamp across sources, so a single event
  is lined up across artifacts. Time windows also apply inside the search tools.
- **Recording findings** — events, IOCs, leads, proven absences, entities, and links between
  entities. Plus the ✨ marks on the rows behind a claim.
- **Case management** — create or open a case, import evidence, tag rows, assign a source to a host
  group, and maintain the investigation plan and progress note.

It **reads the intel cache** for what's already known about an indicator, at no quota cost — but it
does **not** spend fresh VirusTotal or MaxMind lookups on its own. That stays your call.

### What needs your approval

Claude Code prompts you in the terminal for exactly three tools, every time:

- **`import_evidence`** — bringing files into the case
- **`tag_rows`** — applying Malicious / Suspicious / Unknown / Benign
- **`set_source_group`** — attributing a source to a host

Everything else runs without a prompt, including recording events and creating a case — those are all
reversible and reviewable in the Case Report. `import_evidence` takes a whole list of hosts and paths
on purpose, so importing a triage package is *one* approval rather than one per file.

Two things the agent structurally cannot do: mark an entity **Cleared**, and set a verdict in the
Case Report. Both are yours alone.

## What it produces — your review surfaces

Findings land in panels you toggle from the workspace search bar, grouped under a ✨ **AI agent**
label so it's clear which panels the agent writes to.

### ✨ Marks

As the agent makes a claim, it marks the exact rows that back it up with a short note of why. Filter
the grid to just the marked rows to see precisely the evidence it cited.

### Constellation

The case graph. Each node is an **event** — something the agent concluded happened — corroborated by
the specific rows across artifacts that prove it, with an optional MITRE ATT&CK technique and the
accounts involved. Views: a graph, a **time axis**, and an **IOCs** view linking indicators to the
events they appear in. Click any event to pivot straight to its evidence rows.

### Timeline

A curated, chronological super-timeline built from the recorded events (Time · Type · Source · Host ·
User · Description) — sortable, filterable, and exportable to l2t_csv-style CSV. Click a row to jump
to its evidence, or build it as a grid source and double-click through from there.

### IOC catalog

The indicators the agent has cataloged, grouped by type. Cataloging an IOC **never sends it
anywhere** — pushing an indicator to the Intel grid stays your decision.

### Investigation plan

A living plan — leads, each to-do / active / done — plus a short progress note. Both persist in the
workspace and are handed back to the agent when it resumes, so a long investigation continues instead
of restarting. You can read and edit them too.

### Systems & Accounts

The **subjects** of the case: the machines and the user/service accounts it's about, as opposed to
indicators you'd hunt. The list builds itself from the case's own data — every source's host group,
plus every account or host named in a recorded event — and you or the agent can add to it and set a
status (**Compromised / Suspected / Cleared / Unknown**), a role, and notes. A badge shows who added
each one (`AI` or `Analyst`); purely derived entries have no badge.

Its headline output is the **collection gap**: systems the data names but whose artifacts nobody ever
pulled, banner-flagged as *"N systems with no data collected"*. Those are the machines you can't
pivot into, which is usually the thing you most need to know.

> **Accounts are never merged across domains.** `EXAMPLE\admin` and `OTHER\admin` stay two separate
> accounts — silently merging principals would corrupt every attribution downstream. Names that look
> like the same thing are only ever *suggested* as links, and a merge has to be confirmed. A
> `matched` badge means collection was inferred from a short-name match, which can be wrong if two
> domains share a host name.

### Case Report

Every claim in the case in one review queue — events, leads, proven absences, and entity verdicts —
with the pending ones first, grouped by host, so you see what still needs you and on which machine.

- **Approve** (✓) records your agreement.
- **Reject** (✗) **requires a reason**, which is kept and shown back to the agent.

Rejecting is *not* deleting — the claim stays, greyed and struck through, with your reason attached.
Anything resolved can be undone back to pending. Amber flags mark what to look at first:
`overturned`, `unsettled`, `stale`, `single-source`, `not-collected`. The telescope button jumps a
claim to where its evidence lives (an event → the Constellation, a lead → the Investigation panel, an
entity → Systems & Accounts).

Note that **reviewed items are hidden by default** — tick *show reviewed* to see them. And when a
host group has two or more pending items, an **Approve N** button approves all of them at once, with
no reason and no confirmation.

## Proven absences

Some of the most useful things in an investigation are the ones that *didn't* happen — no ransomware
extensions under the shares after the push, zero Type-10 logons in a host's Security log. The agent
records these as **negatives**, and what makes them trustworthy is that the **scope is stored with
them**: which sources, which terms, which time window. So they can be re-run rather than taken on
faith.

A second kind, an **evidence gap**, is a claim about the evidence itself — a parser that failed, an
artifact class nobody could parse. A gap has no search behind it and can never be machine-re-checked.

Negatives don't get their own panel; they appear in the Case Report badged `Negative`, with their
coverage on the detail line (e.g. *searched 12 sources for `.locked` in a time window — 0 rows*).
Two flags matter:

- **`stale`** — a source was imported *after* this absence was established, so it was never searched.
  Stale means **unverified against the current case**, not wrong.
- **`overturned`** — a re-check found rows. The record is kept and flagged rather than quietly
  re-baselined, because the rows that broke it are the finding.

Re-verification is an agent action, not a button — the report tells you it's needed; ask the agent to
re-check. And read the scope line before treating *"not present"* as *"did not happen"*: an absence
is only ever true relative to what was actually searched.

## MITRE ATT&CK

Techniques are resolved against MITRE's official ATT&CK catalog, **baked into the app at build time**
— there's no runtime network call for it and nothing to configure. A retired technique id is upgraded
to its current one automatically rather than rejected. An id that isn't in the catalog is kept but
shown as `(unverified)`, so a hallucinated technique is visibly marked instead of silently trusted.
You can type a technique by hand too, and it goes through the same resolution.

> ATT&CK data is © MITRE, licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Reports
> you publish from it should attribute MITRE ATT&CK.

## Where your data goes

To reason about your case, the agent sends **the workspace data it reads** — rows, columns, and
cached intel it queries — to Claude, through your own Claude Code session. That's the only place it
goes, and only while you have an agent running.

There is no pink-lemonade account and no pink-lemonade server. The app's own server is bound to
`127.0.0.1` and never accepts a connection from your network. Everything else — workspaces, tags,
sightings, watchlists, the intel cache — stays in local files on your machine.

## Next

→ [Workspaces](workspaces.md) and [Exploring data](exploring-data.md) — the data the agent operates on
→ [Intel & watchlists](intel.md) — the enrichment cache it reads from
