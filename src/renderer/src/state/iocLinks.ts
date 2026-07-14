import type { CsvEvent, CsvIoc } from './csvTypes'

// IOC↔event linkage for the constellation's "IOCs" view, as the UNION of two signals:
//   1. a curated TEXT match — the IOC value appears in the event's label, description, or an evidence
//      `matched` term (cheap, renderer-side; catches indicators the analyst named directly); and
//   2. a CONTENT match — the IOC value actually occurs in one of the event's evidence ROWS, computed
//      in the worker (it has the row text the renderer doesn't) and passed in as `contentLinks`.
// (2) is what makes an indicator buried inside a long command (e.g. an email in a curl/msiexec line)
// link to its event even when no curated field mentions it. Pure: same inputs → same graph.

/** IOC values shorter than this are too generic to substring-match reliably — left unlinked. */
export const MIN_IOC_LEN = 3

/** Lowercased text to scan for an event: its label, description, and every evidence `matched` term. */
function eventHaystack(ev: CsvEvent): string {
  const parts: string[] = [ev.label]
  if (ev.description) parts.push(ev.description)
  for (const e of ev.evidence) if (e.matched) parts.push(e.matched)
  return parts.join('\n').toLowerCase()
}

export interface IocLink {
  ioc: CsvIoc
  /** Ids of the events this IOC appears in (in `events` order). Always ≥1 for a linked IOC. */
  eventIds: string[]
}

export interface IocLinkGraph {
  /** IOCs found in ≥1 event, each with the events it links to. */
  linked: IocLink[]
  /** IOCs not found in any event (or too short to match) — shown greyed, no edges. */
  unlinked: CsvIoc[]
}

/**
 * Derive which events each IOC links to (see file header) — the union of the curated text match and
 * the worker-computed `contentLinks` (iocId → eventIds whose evidence rows actually contain the value).
 */
export function deriveIocLinks(
  iocs: CsvIoc[],
  events: CsvEvent[],
  contentLinks: Array<{ iocId: string; eventIds: string[] }> = []
): IocLinkGraph {
  const hay = events.map((ev) => ({ id: ev.id, text: eventHaystack(ev) }))
  const order = new Map(events.map((ev, i) => [ev.id, i]))
  const content = new Map(contentLinks.map((l) => [l.iocId, l.eventIds]))
  const linked: IocLink[] = []
  const unlinked: CsvIoc[] = []
  for (const ioc of iocs) {
    const ids = new Set<string>()
    const needle = ioc.value.trim().toLowerCase()
    if (needle.length >= MIN_IOC_LEN) {
      for (const h of hay) if (h.text.includes(needle)) ids.add(h.id)
    }
    for (const eid of content.get(ioc.id) ?? []) ids.add(eid)
    if (ids.size) linked.push({ ioc, eventIds: [...ids].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)) })
    else unlinked.push(ioc)
  }
  return { linked, unlinked }
}
