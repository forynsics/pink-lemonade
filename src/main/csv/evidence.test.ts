import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'fs'
import { join, sep, basename } from 'path'
import { tmpdir } from 'os'
import { realpathSync } from 'fs'
import {
  binaryContentReason,
  classifyEvidence,
  detectEncoding,
  groupAtDepth,
  groupForPath,
  hostLabel,
  inferGroupDepth,
  isInsideDir,
  looksBinary,
  pickUniqueName,
  planSourceNaming,
  resolveInsideRoot,
  summarizeNotImportable,
  unsupportedReason,
  utf16beReason,
  walkEvidence
} from './evidence'

// A realistic two-host triage layout inside the root, plus a secret OUTSIDE it that the containment
// checks must never be able to reach.
let root: string
let outside: string
let parent: string

beforeAll(() => {
  parent = realpathSync(mkdtempSync(join(tmpdir(), 'pl-evidence-')))
  root = join(parent, 'evidence')
  outside = join(parent, 'outside')
  mkdirSync(join(root, 'HOST-A'), { recursive: true })
  mkdirSync(join(root, 'HOST-B'), { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(root, 'HOST-A', 'Amcache.csv'), 'a,b\n1,2\n')
  writeFileSync(join(root, 'HOST-A', 'notes.pdf'), 'not ingestible')
  writeFileSync(join(root, 'HOST-B', 'Amcache.csv'), 'a,b\n3,4\n')
  writeFileSync(join(root, 'loose.csv'), 'a\n1\n')
  writeFileSync(join(outside, 'secrets.csv'), 'password\nhunter2\n')
})

afterAll(() => {
  rmSync(parent, { recursive: true, force: true })
})

describe('resolveInsideRoot', () => {
  it('resolves an ordinary relative path to its real location inside the root', () => {
    expect(resolveInsideRoot(root, 'HOST-A/Amcache.csv')).toBe(join(realpathSync(root), 'HOST-A', 'Amcache.csv'))
  })

  it('accepts a path to a file that does not exist yet, still inside the root', () => {
    expect(resolveInsideRoot(root, 'HOST-A/future.csv')).toBe(join(realpathSync(root), 'HOST-A', 'future.csv'))
  })

  // The whole point of the boundary: none of these may ever return a path.
  it('refuses ../ traversal out of the root', () => {
    expect(() => resolveInsideRoot(root, '../outside/secrets.csv')).toThrow(/outside the evidence root/)
  })

  it('refuses nested ../../ traversal', () => {
    expect(() => resolveInsideRoot(root, 'HOST-A/../../outside/secrets.csv')).toThrow(/outside the evidence root/)
  })

  it('refuses an absolute POSIX path', () => {
    expect(() => resolveInsideRoot(root, '/etc/passwd')).toThrow(/Absolute paths are not accepted/)
  })

  it('refuses a drive-qualified Windows path', () => {
    expect(() => resolveInsideRoot(root, 'C:\\Windows\\System32\\config\\SAM')).toThrow(/Absolute paths are not accepted/)
  })

  it('refuses a UNC path', () => {
    expect(() => resolveInsideRoot(root, '\\\\server\\share\\loot.csv')).toThrow(/Absolute paths are not accepted/)
  })

  it('refuses backslash traversal', () => {
    expect(() => resolveInsideRoot(root, '..\\outside\\secrets.csv')).toThrow(/Absolute paths are not accepted|outside the evidence root/)
  })

  it('refuses an empty path', () => {
    expect(() => resolveInsideRoot(root, '   ')).toThrow(/required/)
  })

  it('does not treat a sibling directory sharing the root prefix as inside it', () => {
    // `<parent>/evidence-x` startsWith `<parent>/evidence` textually — the separator-boundary
    // compare is what keeps it out. A prefix-only check would wrongly admit this.
    mkdirSync(`${root}-x`, { recursive: true })
    writeFileSync(join(`${root}-x`, 'loot.csv'), 'x\n')
    expect(() => resolveInsideRoot(root, `../${basename(root)}-x/loot.csv`)).toThrow(/outside the evidence root/)
  })

  it('refuses a symlink inside the root that points out of it', () => {
    let linked = false
    try {
      symlinkSync(outside, join(root, 'link-out'), 'junction')
      linked = true
    } catch {
      /* symlink creation needs privilege on some Windows configs — skip rather than fail */
    }
    if (!linked) return
    expect(() => resolveInsideRoot(root, 'link-out/secrets.csv')).toThrow(/outside the evidence root/)
    rmSync(join(root, 'link-out'), { recursive: true, force: true })
  })

  it('throws when the root itself does not exist', () => {
    expect(() => resolveInsideRoot(join(parent, 'nope'), 'a.csv')).toThrow(/does not exist/)
  })
})

describe('walkEvidence', () => {
  it('lists files relative to the root with the host group from the subdirectory', () => {
    const files = walkEvidence(realpathSync(root), realpathSync(root)).files
    const amcache = files.filter((f) => f.name === 'Amcache.csv')
    expect(amcache.map((f) => f.path).sort()).toEqual(['HOST-A/Amcache.csv', 'HOST-B/Amcache.csv'])
    expect(amcache.map((f) => f.group).sort()).toEqual(['HOST-A', 'HOST-B'])
  })

  it('always uses / separators, so the agent gets back what it can pass in', () => {
    const files = walkEvidence(realpathSync(root), realpathSync(root)).files
    expect(files.every((f) => !f.path.includes(sep === '/' ? '\\' : '\\'))).toBe(true)
  })

  it('reports a file at the root as ungrouped', () => {
    const files = walkEvidence(realpathSync(root), realpathSync(root)).files
    expect(files.find((f) => f.name === 'loose.csv')?.group).toBeNull()
  })

  it('lists non-importable files but flags them, rather than hiding them', () => {
    const files = walkEvidence(realpathSync(root), realpathSync(root)).files
    const pdf = files.find((f) => f.name === 'notes.pdf')
    expect(pdf).toBeDefined()
    expect(pdf?.importable).toBe(false)
    expect(files.find((f) => f.name === 'loose.csv')?.importable).toBe(true)
  })

  it('narrows to one host when started at a subdirectory, still reporting root-relative paths', () => {
    const files = walkEvidence(realpathSync(root), join(realpathSync(root), 'HOST-A')).files
    expect(files.map((f) => f.path).sort()).toEqual(['HOST-A/Amcache.csv', 'HOST-A/notes.pdf'])
  })
})

describe('hostLabel / groupForPath', () => {
  // KAPE names its target dir `<host>-<drive>.<16-hex>`; the raw name is what lands in the
  // Timeline's Host column if we don't strip it.
  it('strips the KAPE drive+id suffix to leave the host', () => {
    expect(hostLabel('host-a-C.0123456789abcdef')).toBe('host-a')
    expect(hostLabel('host-b-C.fedcba9876543210')).toBe('host-b')
  })

  it('keeps an ordinary folder name untouched', () => {
    expect(hostLabel('HOST-A')).toBe('HOST-A')
    expect(hostLabel('PaloAlto-Perimeter')).toBe('PaloAlto-Perimeter')
  })

  it('does not fire on lookalikes that are not the KAPE signature', () => {
    expect(hostLabel('host-C.short')).toBe('host-C.short') // id too short
    expect(hostLabel('host-CC.0123456789abcdef')).toBe('host-CC.0123456789abcdef') // two-letter drive
    expect(hostLabel('host-C.11f6731fb786b22z')).toBe('host-C.11f6731fb786b22z') // not hex
  })

  it('derives the same group from a nested path that list_evidence reports', () => {
    expect(groupForPath('host-a-C.0123456789abcdef/ProgramExecution/Amcache.csv')).toBe('host-a')
    expect(groupForPath('loose.csv')).toBeNull()
  })
})

describe('inferGroupDepth / groupAtDepth', () => {
  // The real sample-data layout: two container levels above the host. Taking component 0 labelled
  // every file of every machine with the container name, collapsing all hosts into one group.
  const NESTED = [
    'triage_export/Parsed_Modules/host-a-C.0123456789abcdef/EventLogs/hayabusa_events_offline.csv',
    'triage_export/Parsed_Modules/host-b-C.fedcba9876543210/EventLogs/hayabusa_events_offline.csv',
    'triage_export/Parsed_Modules/host-c-C.00112233445566aa/FileSystem/NTFS.csv'
  ]

  it('finds the host level beneath container directories', () => {
    expect(inferGroupDepth(NESTED)).toBe(2)
    expect(NESTED.map((p) => groupAtDepth(p, 2))).toEqual(['host-a', 'host-b', 'host-c'])
  })

  it('finds the KAPE host level even when only ONE host is present', () => {
    // The set does not branch, so the partition rule alone would descend into artifact categories.
    // The KAPE signature is what pins it — this is the single-host import case.
    const one = NESTED.slice(0, 1)
    expect(inferGroupDepth(one)).toBe(2)
    expect(groupAtDepth(one[0], inferGroupDepth(one))).toBe('host-a')
  })

  it('still handles hosts sitting at the top level', () => {
    const flat = ['HOST-A/Amcache.csv', 'HOST-B/Amcache.csv']
    expect(inferGroupDepth(flat)).toBe(0)
    expect(flat.map((p) => groupAtDepth(p, 0))).toEqual(['HOST-A', 'HOST-B'])
  })

  it('falls back to the level that partitions the set when there is no KAPE signature', () => {
    const nested = ['export/2026/HOST-A/logs/a.csv', 'export/2026/HOST-B/logs/b.csv']
    expect(inferGroupDepth(nested)).toBe(2)
    expect(nested.map((p) => groupAtDepth(p, 2))).toEqual(['HOST-A', 'HOST-B'])
  })

  it('reports no group for a file shallower than the host level', () => {
    expect(groupAtDepth('perimeter_export.csv', 2)).toBeNull()
    expect(groupAtDepth('triage_export/loose.csv', 2)).toBeNull()
  })

  it('does not run past the depth cap into artifact-category directories', () => {
    const deep = ['a/b/c/d/e/f/file.csv']
    expect(inferGroupDepth(deep)).toBeLessThanOrEqual(4)
  })

  it('returns 0 for files loose at the root', () => {
    expect(inferGroupDepth(['a.csv', 'b.csv'])).toBe(0)
  })
})

describe('classifyEvidence / unsupportedReason', () => {
  // Must match the app's OWN import dialog (csv/ipc.ts) — the analyst and the agent should never
  // disagree about what is importable.
  it('routes delimited text to the CSV parser', () => {
    for (const n of ['a.csv', 'a.tsv', 'a.txt', 'a.log', 'A.CSV']) expect(classifyEvidence(n)).toBe('delimited')
  })

  it('routes workbooks to the Excel ingester, not the CSV parser', () => {
    for (const n of ['a.xlsx', 'a.xlsm', 'Hindsight_output.XLSX']) expect(classifyEvidence(n)).toBe('excel')
  })

  // These are the ones that used to "import" as thousands of garbage rows.
  it('refuses everything else', () => {
    for (const n of ['NTFS.sqlite', 'Cache0000.bin_0000.bmp', 'notes.pdf', 'pkg.7z', 'System.evtx', 'user1'])
      expect(classifyEvidence(n)).toBe('unsupported')
  })

  it('explains what the file is and what IS importable', () => {
    const r = unsupportedReason('NTFS.sqlite')
    expect(r).toContain('NTFS.sqlite')
    expect(r).toContain('.sqlite')
    expect(r).toMatch(/SQLite database/)
    expect(r).toMatch(/\.csv/) // always states what can be imported
  })

  it('gives the artifact-specific remediation a DFIR analyst needs', () => {
    expect(unsupportedReason('System.evtx')).toMatch(/EvtxECmd|Hayabusa/)
    expect(unsupportedReason('pkg.7z')).toMatch(/archive/i)
    expect(unsupportedReason('Cache0000.bmp')).toMatch(/image/i)
  })

  it('handles a file with no extension without claiming a bogus type', () => {
    const r = unsupportedReason('user1')
    expect(r).toContain('no extension')
  })
})

describe('detectEncoding', () => {
  const u8 = (s: string): Uint8Array => new TextEncoder().encode(s)
  const u16le = (s: string, bom = false): Uint8Array => {
    const body = Buffer.from(s, 'utf16le')
    return bom ? Uint8Array.from([0xff, 0xfe, ...body]) : new Uint8Array(body)
  }

  it('reads plain UTF-8 as utf8', () => {
    expect(detectEncoding(u8('Timestamp,RuleTitle\n2026-01-01,Foo\n'))).toBe('utf8')
  })

  // The regression: EZ tool console logs are UTF-16LE, and a NUL-scan called them binary.
  it('recognises UTF-16LE with a BOM', () => {
    expect(detectEncoding(u16le('Processing file ...\r\nDone\r\n', true))).toBe('utf16le')
  })

  it('recognises UTF-16LE without a BOM, from the NUL parity', () => {
    expect(detectEncoding(u16le('Processing file ...\r\nDone\r\n'))).toBe('utf16le')
  })

  it('recognises UTF-16BE by its BOM', () => {
    expect(detectEncoding(Uint8Array.from([0xfe, 0xff, 0x00, 0x41, 0x00, 0x42]))).toBe('utf16be')
  })

  it('still calls unpatterned NUL content binary', () => {
    expect(detectEncoding(Uint8Array.from([0x00, 0x00, 0x00, 0x00, 0x42, 0x00, 0x00, 0x99]))).toBe('binary')
  })

  it('names UTF-16BE accurately instead of blaming the extension', () => {
    const r = utf16beReason('SumECmdConsoleLog.txt')
    expect(r).toContain('SumECmdConsoleLog.txt')
    expect(r).toMatch(/BIG-endian/)
    expect(r).toMatch(/UTF-8/)
    expect(r).not.toMatch(/misleading/) // the extension is NOT the problem here
  })
})

describe('looksBinary', () => {
  const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)

  it('accepts ordinary delimited text', () => {
    expect(looksBinary(bytes('Timestamp,RuleTitle\n2026-01-01,Foo\n'))).toBe(false)
  })

  it('no longer rejects UTF-16LE text — it is text, and we decode it', () => {
    expect(looksBinary(new Uint8Array(Buffer.from('a,b\r\n1,2\r\n', 'utf16le')))).toBe(false)
  })

  it('accepts text with CRLF, quotes and non-ASCII', () => {
    expect(looksBinary(bytes('a,b\r\n"x — ü",1\r\n'))).toBe(false)
  })

  // A .csv holding a renamed image or a memory dump used to "import" as a 0-row source with
  // garbage columns, which the agent then had to treat as evidence.
  it('still rejects genuinely binary content', () => {
    expect(looksBinary(new Uint8Array([0x00, 0x01, 0x02]))).toBe(true)
    expect(looksBinary(new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x42, 0x00, 0x00, 0x99]))).toBe(true)
  })

  it('treats an empty head as text — emptiness is a separate, meaningful case', () => {
    expect(looksBinary(new Uint8Array([]))).toBe(false)
  })

  it('names the file and its misleading extension in the reason', () => {
    const r = binaryContentReason('Cache0000.csv')
    expect(r).toContain('Cache0000.csv')
    expect(r).toContain('.csv extension is misleading')
    expect(r).toMatch(/\.tsv/)
  })
})

describe('isInsideDir', () => {
  // Guards the evidence root against the workspace folder: cases are WRITTEN to the workspace dir by
  // an agent-callable tool, so an overlap would let the agent write into evidence.
  it('detects a directory nested inside another', () => {
    expect(isInsideDir(join(root, 'HOST-A'), root)).toBe(true)
  })

  it('treats a directory as inside itself', () => {
    expect(isInsideDir(root, root)).toBe(true)
  })

  it('does not treat a prefix-sharing sibling as inside', () => {
    expect(isInsideDir(`${root}-archive`, root)).toBe(false)
  })

  it('is false for unrelated trees, in both directions', () => {
    expect(isInsideDir(outside, root)).toBe(false)
    expect(isInsideDir(root, outside)).toBe(false)
  })

  it('resolves a not-yet-created directory rather than waving it through', () => {
    expect(isInsideDir(join(root, 'not-created-yet'), root)).toBe(true)
  })
})

describe('summarizeNotImportable', () => {
  // A single host's RDP bitmap cache is thousands of .bmp files — listing every path would bury the
  // handful of artifacts that matter, so the tool reports counts by type instead.
  it('counts non-importable files by extension, most numerous first', () => {
    const files = [
      { path: 'h/a.bmp', name: 'a.bmp', group: 'h', bytes: 1, importable: false },
      { path: 'h/b.bmp', name: 'b.bmp', group: 'h', bytes: 1, importable: false },
      { path: 'h/c.sqlite', name: 'c.sqlite', group: 'h', bytes: 1, importable: false },
      { path: 'h/d.csv', name: 'd.csv', group: 'h', bytes: 1, importable: true }
    ]
    expect(summarizeNotImportable(files)).toEqual([
      { type: 'bmp', count: 2 },
      { type: 'sqlite', count: 1 }
    ])
  })

  it('buckets extensionless files rather than dropping them', () => {
    const files = [{ path: 'h/user1', name: 'user1', group: 'h', bytes: 1, importable: false }]
    expect(summarizeNotImportable(files)).toEqual([{ type: '(no extension)', count: 1 }])
  })
})

describe('planSourceNaming', () => {
  it('leaves a non-colliding name alone', () => {
    expect(planSourceNaming('Prefetch.csv', 'host-a', [{ id: 0, name: 'Amcache.csv', group: 'host-a' }])).toEqual({
      name: 'Prefetch.csv'
    })
  })

  // The point of the simplification: the Group/ prefix IS the disambiguator. Two hosts holding the
  // same filename keep that filename, so `host-a/hayabusa_events_offline.csv` — the form every tool
  // description gives as THE example — actually works, and importing the second host does not
  // rename the first out from under an identifier already handed back.
  it('keeps the plain filename when the collision is across DIFFERENT groups', () => {
    const plan = planSourceNaming('hayabusa_events_offline.csv', 'host-b', [
      { id: 0, name: 'hayabusa_events_offline.csv', group: 'host-a' }
    ])
    expect(plan).toEqual({ name: 'hayabusa_events_offline.csv' })
  })

  it('keeps the plain filename for a third and fourth host too', () => {
    const existing = [
      { id: 0, name: 'a.csv', group: 'h1' },
      { id: 1, name: 'a.csv', group: 'h2' },
      { id: 2, name: 'a.csv', group: 'h3' }
    ]
    expect(planSourceNaming('a.csv', 'h4', existing)).toEqual({ name: 'a.csv' })
  })

  // No path can tell these apart, so a counter is the only honest answer — a group prefix would
  // read identically on both.
  it('counters a collision WITHIN the same group', () => {
    expect(planSourceNaming('Amcache.csv', 'host-a', [{ id: 0, name: 'Amcache.csv', group: 'host-a' }]).name).toBe(
      'Amcache.csv (2)'
    )
  })

  it('counters a collision among ungrouped sources', () => {
    expect(planSourceNaming('Amcache.csv', null, [{ id: 0, name: 'Amcache.csv', group: null }]).name).toBe(
      'Amcache.csv (2)'
    )
  })

  it('does not treat an ungrouped source as colliding with a grouped one', () => {
    expect(planSourceNaming('Amcache.csv', 'host-a', [{ id: 0, name: 'Amcache.csv', group: null }]).name).toBe(
      'Amcache.csv'
    )
  })

  it('keeps counting past an existing counter within the group', () => {
    const existing = [
      { id: 0, name: 'a.csv', group: 'host-a' },
      { id: 1, name: 'a.csv (2)', group: 'host-a' }
    ]
    expect(planSourceNaming('a.csv', 'host-a', existing).name).toBe('a.csv (3)')
  })

  it('never returns a rename — the retroactive rename is gone', () => {
    const plan = planSourceNaming('a.csv', 'h2', [{ id: 0, name: 'a.csv', group: 'h1' }])
    expect('rename' in plan).toBe(false)
  })
})

describe('pickUniqueName', () => {
  it('keeps the plain filename when nothing collides', () => {
    expect(pickUniqueName('Amcache.csv', 'HOST-A', [])).toBe('Amcache.csv')
  })

  it('qualifies with the host when the bare name is taken', () => {
    expect(pickUniqueName('Amcache.csv', 'HOST-B', ['Amcache.csv'])).toBe('HOST-B — Amcache.csv')
  })

  it('falls back to a counter when there is no host to qualify with', () => {
    expect(pickUniqueName('Amcache.csv', null, ['Amcache.csv'])).toBe('Amcache.csv (2)')
  })

  it('falls back to a counter when the qualified name is also taken', () => {
    expect(pickUniqueName('Amcache.csv', 'HOST-B', ['Amcache.csv', 'HOST-B — Amcache.csv'])).toBe('Amcache.csv (2)')
  })

  it('treats collisions case-insensitively, matching how sources are looked up', () => {
    expect(pickUniqueName('Amcache.csv', null, ['AMCACHE.CSV'])).toBe('Amcache.csv (2)')
  })

  it('keeps counting past an existing counter suffix', () => {
    expect(pickUniqueName('a.csv', null, ['a.csv', 'a.csv (2)', 'a.csv (3)'])).toBe('a.csv (4)')
  })
})
