# Intel Sweep

Tagging is for marking rows *you* judge. **Intel Sweep** is the other direction: you already have a
set of known-bad indicators — from a report, a watchlist, a threat-intel feed — and you want to find
**every row that mentions any of them**. A sweep scans a source and marks each matching row as a
**sighting**.

## What you can sweep for

Four indicator kinds, all **case-insensitive**:

- **IPv4** — matched as a whole token, so `8.8.8.8` is found inside `explorer.exe connected to
  8.8.8.8` but *not* inside `18.8.8.81`.
- **Domain** — matched as a substring, so `evil.com` also hits `mail.evil.com`.
- **File hash** — MD5 / SHA-1 / SHA-256, whole-token.
- **File name** — whole-token (e.g. `svchost.exe` matches in a path but not in `notsvchost.exe`).

The indicator doesn’t have to be the whole cell — sweeps look *inside* free-text fields (a log
message, a command line), which is exactly where IOCs hide.

## Running a sweep

Open a workspace source and click **Intel Sweep** in the header. In the dialog:

1. **Give it indicators.** Three sources, and you can stack them:
   - **Paste** a list (one per line). URLs are reduced to their domain; defanged values like
     `1[.]2[.]3[.]4` are refanged automatically.
   - **Watchlist ▾** — load a saved IP / domain / hash [watchlist](intel.md#watchlists).
   - **File** — open a `.txt` / `.csv` of indicators.

   As you add them, each line shows a live verdict: a kind chip (IP / domain / hash), a note if it
   was normalized, or a *skip* reason (e.g. IPv6 isn’t swept yet).

   To sweep **file names** — which can’t be told apart from domains automatically — tick
   **“Treat each line as a file name.”**

2. **Choose the scope.** Scan **all columns** (slower, catches IOCs anywhere) or pick specific
   columns for a predictable dataset.

3. **Run it.** A progress bar shows the percentage scanned; big sources stay responsive and the
   sweep can be **canceled**.

If the source already has sightings, you’ll be asked whether to **Add** to them or **Replace** them,
so a re-sweep never wipes your progress by surprise.

## Working with sightings

A row with a sighting gets a red **crosshair** in its row gutter, and the matched value is
**highlighted** in its cell. Click the crosshair to jump straight to the matching cell.

The **“N sightings”** button in the header opens the **Sightings panel** — a roll-up of every
indicator that matched and how many rows it hit:

- **Left-click** an indicator to filter the grid to just its rows; **right-click** to *exclude* it.
- **Show all sightings** filters the grid to every row with any sighting.
- **Clear** everything, one indicator, or a single row’s sighting (right-click a cell →
  **Clear sighting**) to drop false positives.

Sightings are stored in the workspace, independent of tags — so a row can be both a sighting **and**
tagged Malicious.

## From the Intel tab

If you’re looking at indicators in the [Intel grid](intel.md), select them, right-click, and choose
**Run Intel Sweep…** — pick a target workspace + source, and the sweep dialog opens pre-filled. It’s
the fastest way to take “here are the bad indicators” straight to “show me where they appear.”

## A typical flow

1. Import a timeline into a workspace.
2. Open **Intel Sweep**, load your watchlist (or paste the IOCs from a report), scan **all columns**.
3. Open the **Sightings panel**, click the noisiest indicator to see its rows.
4. Pivot ±15 minutes around a sighting, **tag** the blast radius, and clear any false positives.
