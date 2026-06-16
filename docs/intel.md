---
title: "Intel & watchlists"
nav_order: 8
---

# Intel & watchlists

The **Intel** tab is where you add context to indicators — look up what an IP / domain / hash *is*,
and keep curated lists of things you care about. It’s a separate surface from the notepad and
workspaces, opened from **Global Intel** on the Home screen (or a workspace’s own Intel).

## Looking things up

Paste or send indicators into the Intel tab and run them against a **provider**. Results land in a
sortable **Intel grid** — one row per indicator, a column per provider field — which you can sort,
resize, reorder, hide columns on, and export.

Every lookup is cached in an **app-wide store**, keyed by `(provider, indicator)`. So a result is
**never fetched twice** — look the same IP up in another workspace or next week and it comes straight
from the cache. (Clear a cached result from the row’s right-click menu to force a fresh lookup.)

### Providers

- **MaxMind GeoIP** *(included)* — geolocation/ASN from a local MaxMind database file. The first
  time, point it at your `.mmdb`, or let pink-lemonade download **GeoLite2** for you with your free
  MaxMind license key. It’s a local file, so lookups are instant and offline.
- **VirusTotal** and an **AI assistant** are on the roadmap — the engine, cache, and grid are already
  provider-agnostic.

### Global vs. workspace Intel

**Global Intel** is shared across everything. A workspace can also keep **its own** Intel database
(its sibling `.intel.db`), so a single engagement’s lookups stay self-contained. Either way the grid,
cache, and watchlists work the same.

## Watchlists

A **watchlist** is an analyst-curated list of things you want to recognize — corporate subnets, known
bad ASNs, a domain block-list, a set of malware hashes. Open the **Watchlists** panel from the Intel
tab to create and edit them.

Each list has a **kind**, and entries are normalized to match correctly:

- **IP** — individual IPv4 addresses *and* CIDR ranges (matched by range containment), or IPv6.
- **ASN** — autonomous-system numbers (`AS15169`, `15169`).
- **Domain** — bare hosts (URLs and trailing dots are stripped).
- **Hash** — MD5 / SHA-1 / SHA-256.

Paste entries in; anything that doesn’t parse for the list’s kind is reported as skipped. Watchlists
are **global** and saved on your machine, so they’re available everywhere.

Watchlists do double duty: they add context during enrichment, and they’re a one-click **source for
[Intel Sweep](intel-sweep.md)** — load an IP / domain / hash list straight into a sweep.

## Pivoting between Intel and your data

The two surfaces talk to each other in both directions:

- **Into Intel** — right-click a cell (or a column’s distinct values) in a workspace, or use the
  notepad output, and **Send to Intel**. Recognized indicators drop into the Intel tab’s paste box
  for you to review and add.
- **Out of Intel** — select indicators in the Intel grid, right-click, and **Run Intel Sweep…** to
  hunt for them across any open workspace source. With several workspaces open you pick the target;
  with one, it goes straight there.

## A typical flow

1. Triaging a timeline, you keep seeing one external IP. Right-click it → **Send to Global Intel**.
2. In the Intel tab, run **MaxMind GeoIP** — it’s hosting in an unexpected country.
3. Add it to a **“Known bad infra”** watchlist.
4. Later, on a new case, **Intel Sweep** that watchlist across the new timeline to see if the same
   infrastructure shows up.
