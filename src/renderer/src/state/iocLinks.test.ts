import { describe, it, expect } from 'vitest'
import { deriveIocLinks } from './iocLinks'
import type { CsvEvent, CsvEventEvidence, CsvIoc } from './csvTypes'

const evid = (matched: string): CsvEventEvidence => ({
  sourceId: 1,
  sourceName: 'Sec',
  matched,
  count: 1,
  rids: [1],
  spans: [],
  tsMin: null,
  tsMax: null
})
const ev = (id: string, label: string, evidence: CsvEventEvidence[] = [], description: string | null = null): CsvEvent => ({
  id,
  label,
  description,
  technique: null,
  createdAt: 0,
  actor: 'ai',
  users: [],
  evidence
})
const ioc = (id: string, value: string, type = 'ip'): CsvIoc => ({ id, value, type, context: null, createdAt: 0 })

describe('deriveIocLinks', () => {
  it('links an IOC to an event when its value appears in an evidence matched term', () => {
    const g = deriveIocLinks([ioc('i1', '192.0.2.30')], [ev('e1', 'C2 beacon', [evid('192.0.2.30')])])
    expect(g.linked).toHaveLength(1)
    expect(g.linked[0].eventIds).toEqual(['e1'])
    expect(g.unlinked).toHaveLength(0)
  })

  it('links via the event label or description (case-insensitive), not only matched terms', () => {
    const g = deriveIocLinks(
      [ioc('i1', 'PHISH.example', 'domain'), ioc('i2', 'dropper.exe', 'filename')],
      [ev('e1', 'Connect to phish.example', []), ev('e2', 'Execution', [], 'Ran Dropper.exe from temp')]
    )
    expect(g.linked.find((l) => l.ioc.id === 'i1')?.eventIds).toEqual(['e1'])
    expect(g.linked.find((l) => l.ioc.id === 'i2')?.eventIds).toEqual(['e2'])
  })

  it('links one IOC to multiple events, in events order', () => {
    const g = deriveIocLinks(
      [ioc('i1', 'beacon.example', 'domain')],
      [ev('a', 'First beacon.example hit', [evid('beacon.example')]), ev('b', 'Other'), ev('c', 'Second beacon.example hit', [evid('beacon.example')])]
    )
    expect(g.linked[0].eventIds).toEqual(['a', 'c'])
  })

  it('buckets an IOC found in no event as unlinked', () => {
    const g = deriveIocLinks([ioc('i1', '198.51.100.40')], [ev('e1', 'Beacon', [evid('192.0.2.50')])])
    expect(g.linked).toHaveLength(0)
    expect(g.unlinked.map((i) => i.id)).toEqual(['i1'])
  })

  it('leaves too-short IOC values unlinked (no trivial-substring noise)', () => {
    const g = deriveIocLinks([ioc('i1', '80')], [ev('e1', 'Port 80 traffic', [evid('80')])])
    expect(g.linked).toHaveLength(0)
    expect(g.unlinked.map((i) => i.id)).toEqual(['i1'])
  })

  it('links via content (evidence rows) even when no curated text field mentions the value', () => {
    // The email is buried in the install command's rows, not in the label/description/matched term.
    const events = [ev('atera', 'Atera RMM agent installed', [evid('setup.msi')])]
    const iocs = [ioc('i1', 'user42@example.com', 'email')]
    const noContent = deriveIocLinks(iocs, events)
    expect(noContent.linked).toHaveLength(0) // text match alone misses it
    const withContent = deriveIocLinks(iocs, events, [{ iocId: 'i1', eventIds: ['atera'] }])
    expect(withContent.linked[0].eventIds).toEqual(['atera'])
    expect(withContent.unlinked).toHaveLength(0)
  })

  it('unions text + content links without duplicating an event', () => {
    const events = [ev('a', 'c2node.example beacon', [evid('c2node.example')]), ev('b', 'Second hit')]
    const g = deriveIocLinks([ioc('i1', 'c2node.example', 'domain')], events, [{ iocId: 'i1', eventIds: ['a', 'b'] }])
    expect(g.linked[0].eventIds).toEqual(['a', 'b']) // 'a' from both signals → not duplicated, events order
  })
})
