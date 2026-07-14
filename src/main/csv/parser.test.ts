import { describe, it, expect, afterEach } from 'vitest'
import { writeFile, mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { parseCsvStream } from './parser'

// The low-level RFC-4180 tokenizing is csv-parse's job (and its own test suite). These cover the
// app-specific behavior parseCsvStream adds on top: delimiter detection, header sanitization,
// batching/cancel, BOM stripping, and that the common quoting/line-ending cases parse end-to-end.
describe('parseCsvStream', () => {
  let dir: string | null = null
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = null
  })

  async function writeTmp(name: string, content: string): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), 'pl-csv-test-'))
    const p = join(dir, name)
    await writeFile(p, content, 'utf-8')
    return p
  }

  /** Parse a whole file in memory; returns the (sanitized) header originals, all rows, and result. */
  async function parseAll(content: string, name = 't.csv') {
    const path = await writeTmp(name, content)
    let header: string[] = []
    const rows: string[][] = []
    const res = await parseCsvStream(path, {
      onHeader: (h) => (header = h.columns.map((c) => c.original)),
      onRows: (b) => void rows.push(...b)
    })
    return { header, rows, res }
  }

  it('emits a sanitized header then batched rows', async () => {
    const { header, rows, res } = await parseAll('source.ip,country\n192.0.2.45,US\n198.51.100.23,AU\n')
    expect(header).toEqual(['source.ip', 'country'])
    expect(rows).toEqual([
      ['192.0.2.45', 'US'],
      ['198.51.100.23', 'AU']
    ])
    expect(res.rowsRead).toBe(2)
    expect(res.delimiter).toBe(',')
    expect(res.canceled).toBe(false)
  })

  it('handles quoted fields with embedded delimiter and newline', async () => {
    const { rows } = await parseAll('name,note\n"alpha, bravo","line1\nline2"\n')
    expect(rows).toEqual([['alpha, bravo', 'line1\nline2']])
  })

  it('handles escaped quotes ("")', async () => {
    const { rows } = await parseAll('a\n"she said ""hi"""\n')
    expect(rows).toEqual([['she said "hi"']])
  })

  it('parses tricky quoting that spans lines (escaped + embedded newline)', async () => {
    const { rows } = await parseAll('h1,h2\n"charlie, ""J""","x\ny"\n42,end\n')
    expect(rows).toEqual([
      ['charlie, "J"', 'x\ny'],
      ['42', 'end']
    ])
  })

  it('parses CRLF line endings', async () => {
    const { header, rows } = await parseAll('a,b\r\n1,2\r\n3,4\r\n')
    expect(header).toEqual(['a', 'b'])
    expect(rows).toEqual([
      ['1', '2'],
      ['3', '4']
    ])
  })

  it('skips blank lines but keeps empty fields', async () => {
    const { rows } = await parseAll('a,b\n\n1,\n')
    expect(rows).toEqual([['1', '']])
  })

  it('auto-detects a TSV delimiter', async () => {
    const path = await writeTmp('t.tsv', 'a\tb\n1\t2\n')
    let delim = ''
    await parseCsvStream(path, { onHeader: (h) => (delim = h.delimiter), onRows: () => {} })
    expect(delim).toBe('\t')
  })

  it('strips a leading UTF-8 BOM from the first header (Excel/Windows export)', async () => {
    const { header, rows } = await parseAll('\uFEFFsource.ip,country\n192.0.2.45,US\n', 'bom.csv')
    // Without BOM stripping the first column reads "source.ip" and never matches.
    expect(header).toEqual(['source.ip', 'country'])
    expect(rows).toEqual([['192.0.2.45', 'US']])
  })

  it('handles a header-only file (no data rows)', async () => {
    const path = await writeTmp('h.csv', 'only,header')
    let header: string[] = []
    let rowCount = 0
    const res = await parseCsvStream(path, {
      onHeader: (h) => (header = h.columns.map((c) => c.name)),
      onRows: (b) => void (rowCount += b.length)
    })
    expect(header).toEqual(['c0', 'c1'])
    expect(rowCount).toBe(0)
    expect(res.rowsRead).toBe(0)
  })

  it('stops early when onRows returns false', async () => {
    const path = await writeTmp('big.csv', 'a\n' + Array.from({ length: 50 }, (_, i) => i).join('\n') + '\n')
    let seen = 0
    const res = await parseCsvStream(
      path,
      {
        onHeader: () => {},
        onRows: (b) => {
          seen += b.length
          return false // stop after first batch
        }
      },
      { batchSize: 10 }
    )
    expect(seen).toBe(10)
    expect(res.canceled).toBe(true)
  })
})
