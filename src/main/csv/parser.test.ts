import { describe, it, expect, afterEach } from 'vitest'
import { writeFile, mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { CsvRecordParser, parseCsvStream } from './parser'

/** Run a string through the parser in fixed-size chunks (to exercise chunk boundaries). */
function parseInChunks(text: string, delim: string, chunkSize: number): string[][] {
  const p = new CsvRecordParser(delim)
  const out: string[][] = []
  for (let i = 0; i < text.length; i += chunkSize) {
    out.push(...p.push(text.slice(i, i + chunkSize)))
  }
  out.push(...p.end())
  return out
}

describe('CsvRecordParser', () => {
  it('parses simple rows (LF and CRLF), no trailing newline', () => {
    expect(parseInChunks('a,b\r\n1,2\n3,4', ',', 1024)).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', '4']
    ])
  })

  it('handles quoted fields with embedded delimiter and newline', () => {
    const text = 'name,note\n"Doe, John","line1\nline2"\n'
    expect(parseInChunks(text, ',', 1024)).toEqual([
      ['name', 'note'],
      ['Doe, John', 'line1\nline2']
    ])
  })

  it('handles escaped quotes ("")', () => {
    expect(parseInChunks('a\n"she said ""hi"""\n', ',', 1024)).toEqual([
      ['a'],
      ['she said "hi"']
    ])
  })

  it('is invariant to chunk size (quote/field spanning boundaries)', () => {
    const text = 'h1,h2\n"Doe, ""J""",  "x\ny"\n42,end\n'
    const ref = parseInChunks(text, ',', 4096)
    for (const cs of [1, 2, 3, 5, 7]) {
      expect(parseInChunks(text, ',', cs)).toEqual(ref)
    }
  })

  it('skips fully-blank lines but keeps empty fields', () => {
    expect(parseInChunks('a,b\n\n1,\n', ',', 1024)).toEqual([
      ['a', 'b'],
      ['1', '']
    ])
  })

  it('parses tab-delimited', () => {
    expect(parseInChunks('a\tb\n1\t2\n', '\t', 1024)).toEqual([
      ['a', 'b'],
      ['1', '2']
    ])
  })
})

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

  it('emits a sanitized header then batched rows', async () => {
    const path = await writeTmp('t.csv', 'source.ip,country\n8.8.8.8,US\n1.1.1.1,AU\n')
    let header: string[] = []
    const rows: string[][] = []
    const res = await parseCsvStream(path, {
      onHeader: (h) => (header = h.columns.map((c) => c.original)),
      onRows: (b) => void rows.push(...b)
    })
    expect(header).toEqual(['source.ip', 'country'])
    expect(rows).toEqual([
      ['8.8.8.8', 'US'],
      ['1.1.1.1', 'AU']
    ])
    expect(res.rowsRead).toBe(2)
    expect(res.delimiter).toBe(',')
    expect(res.canceled).toBe(false)
  })

  it('auto-detects a TSV delimiter', async () => {
    const path = await writeTmp('t.tsv', 'a\tb\n1\t2\n')
    let delim = ''
    await parseCsvStream(path, { onHeader: (h) => (delim = h.delimiter), onRows: () => {} })
    expect(delim).toBe('\t')
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
