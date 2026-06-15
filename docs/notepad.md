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

Chaining is the point: e.g. *Base64 decode → Extract IPv4 → Defang* turns an encoded blob into a
clean, shareable indicator list in three clicks.

## Working in the notepad

- **Reorder or remove steps** in the workflow bar to tweak the pipeline.
- **Find (Ctrl+F)** searches the focused pane, highlights every match, and steps through them with
  Enter / Shift+Enter.
- **Current line** is gently highlighted so you don’t lose your place in a long paste.
- **Open / save files** to pull text in from disk or push the output back out.

## Pivoting from data into a notepad

When you’re exploring a CSV (see [Exploring data](exploring-data.md)), you can send a column’s
values straight into a new notepad — handy for grabbing every distinct IP in a column and then
running it through defang or dedupe.
