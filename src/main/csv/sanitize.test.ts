import { describe, it, expect } from 'vitest'
import { sanitizeHeaders, detectDelimiter, headerRowIndex } from './sanitize'

describe('sanitizeHeaders', () => {
  it('maps to positional c0..cN and trims originals', () => {
    expect(sanitizeHeaders([' source.ip ', 'Country'])).toEqual([
      { name: 'c0', original: 'source.ip' },
      { name: 'c1', original: 'Country' }
    ])
  })

  it('fills empty headers with a positional label', () => {
    expect(sanitizeHeaders(['', '  '])).toEqual([
      { name: 'c0', original: 'Column 1' },
      { name: 'c1', original: 'Column 2' }
    ])
  })

  it('de-duplicates display names while keeping safe ids distinct', () => {
    expect(sanitizeHeaders(['ip', 'ip', 'ip'])).toEqual([
      { name: 'c0', original: 'ip' },
      { name: 'c1', original: 'ip (2)' },
      { name: 'c2', original: 'ip (3)' }
    ])
  })

  it('uses positional ids regardless of SQL-keyword headers', () => {
    const cols = sanitizeHeaders(['select', 'drop table'])
    expect(cols.map((c) => c.name)).toEqual(['c0', 'c1'])
  })
})

describe('detectDelimiter', () => {
  it('detects comma / tab / pipe / semicolon by frequency', () => {
    expect(detectDelimiter('a,b,c')).toBe(',')
    expect(detectDelimiter('a\tb\tc')).toBe('\t')
    expect(detectDelimiter('a|b|c')).toBe('|')
    expect(detectDelimiter('a;b;c')).toBe(';')
  })

  it('picks the most frequent when mixed', () => {
    expect(detectDelimiter('a,b;c;d;e')).toBe(';')
  })

  it('defaults to comma when no delimiter present', () => {
    expect(detectDelimiter('single')).toBe(',')
  })
})

describe('headerRowIndex', () => {
  // Hindsight (and other forensic exports) put a report title in a merged row-1 cell. Taking row 0
  // blindly made every column "Hindsight Internet History Forensics (v2024.10) (2)…" and pushed the
  // real header down into the data.
  it('skips a merged title row that ExcelJS expanded into identical cells', () => {
    // What Hindsight actually produces: the merged banner repeated across all 21 columns.
    const title = 'Hindsight Internet History Forensics (v2024.10)'
    const rows = [
      Array(21).fill(title),
      ['Type', 'Timestamp (UTC)', 'URL', 'Title / Name / Status', 'Data / Value / Path'],
      ['url', '2023-11-14', 'http://x', 'X', 'y']
    ]
    expect(headerRowIndex(rows)).toBe(1)
  })

  it('skips a single-cell title row above a wider header', () => {
    const rows = [
      ['Hindsight Internet History Forensics (v2024.10)'],
      ['Type', 'Timestamp', 'URL', 'Title'],
      ['url', '2023-11-14', 'http://x', 'X']
    ]
    expect(headerRowIndex(rows)).toBe(1)
  })

  it('skips a banner row of merged GROUP captions, not just a single title', () => {
    // Hindsight's real shape: a title plus section captions spanning 21 columns.
    const rows = [
      [...Array(9).fill('Hindsight Internet History Forensics'), ...Array(4).fill('URL Specific'),
       ...Array(4).fill('Download Specific'), ...Array(4).fill('Cache Specific')],
      ['Type', 'Timestamp', 'URL', 'Title', 'Data', 'Interp', 'Profile', 'Source', 'A', 'B', 'C', 'D',
       'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M'],
      Array(21).fill('v')
    ]
    expect(headerRowIndex(rows)).toBe(1)
  })

  it('does NOT skip a real header that merely repeats a label', () => {
    // 3 of 4 distinct is well above the half-distinct bar — this is a header, not a banner.
    expect(headerRowIndex([['Name', 'Value', 'Value', 'Path'], ['a', 'b', 'c', 'd']])).toBe(0)
  })

  it('leaves an ordinary sheet whose first row IS the header', () => {
    expect(headerRowIndex([['Type', 'Timestamp'], ['url', '2023-11-14']])).toBe(0)
  })

  it('treats a padded title row (blank trailing cells) as a title', () => {
    const rows = [['Report', '', '', ''], ['A', 'B', 'C', 'D'], ['1', '2', '3', '4']]
    expect(headerRowIndex(rows)).toBe(1)
  })

  it('does not skip when the sheet is genuinely single-column', () => {
    expect(headerRowIndex([['Path'], ['C:\a'], ['C:\b']])).toBe(0)
  })

  it('does not skip when there is no second row to fall back to', () => {
    expect(headerRowIndex([['OnlyRow']])).toBe(0)
  })
})
