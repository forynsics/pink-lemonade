# Notepad — text transforms

The notepad is for quick, repeatable text work: the kind of thing you’d otherwise do in
Notepad++ or a pile of one-off online tools. Paste text in, run it through a chain of tools,
copy the result out.

## How it works

A notepad has two panes:

- **Left** — your input text.
- **Right** — the output after your tools run.

On the far left is the **tool palette**. Clicking a tool adds it as a **step**. Steps run top to
bottom: the input flows through step 1, its result into step 2, and so on, producing the final
output on the right. Edit the input or change a step and the output updates instantly.

If a step can’t process its input, it’s flagged so you can see exactly which step broke the chain.

## What the tools do

The palette covers the common investigation/cleanup needs, for example:

- **Encoding** — Base64 encode/decode, hex encode/decode.
- **IOC extraction** — pull IPv4 addresses (and other indicators) out of noisy text.
- **Defang / refang** — make indicators safe to share (`1.2.3.4` → `1[.]2[.]3[.]4`) or reverse it.
- **Cleanup** — remove duplicate lines, trim whitespace, change case, and similar tidying.
- **Query builders** — turn a list of indicators (one per line) into a ready-to-paste search clause
  for **CQL** (CrowdStrike), **KQL** (Defender / Sentinel), or **SPL** (Splunk).

The palette groups tools under **TEXT / IOC / QUERY** tabs and has a search box, so you can find one
fast. Chaining is the point: e.g. *Base64 decode → Extract IPv4 → Defang* turns an encoded blob into
a clean, shareable indicator list in three clicks.

## Working in the notepad

- **Reorder, remove, or toggle steps** in the workflow bar — flip a step **off** to bypass it
  without deleting it, so you can compare results.
- **Use as Input** promotes the current output back into the input pane to keep building on it.
- **Find (Ctrl+F)** searches the focused pane, highlights every match, and steps through them with
  Enter / Shift+Enter.
- **Current line** is gently highlighted so you don’t lose your place in a long paste.
- **Open / save files** to pull text in from disk or push the output back out.

## Pivoting in and out

When you’re exploring a CSV (see [Exploring data](exploring-data.md)), you can send a column’s
values straight into a new notepad — handy for grabbing every distinct IP in a column and then
running it through defang or dedupe. Going the other way, the output pane’s **Send to Intel** drops
recognized indicators into the [Intel tab](intel.md) for lookup.
