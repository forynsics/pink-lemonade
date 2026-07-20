import { parse } from 'csv-parse'
import { createReadStream, closeSync, openSync, readSync } from 'fs'
import { stat } from 'fs/promises'
import { detectEncoding, utf16beReason, type TextEncodingKind } from './evidence'
import { detectDelimiter, sanitizeHeaders, type ColumnMap } from './sanitize'

// Streaming CSV/TSV ingest. The low-level RFC-4180 tokenizing (quotes, escapes, embedded
// delimiters/newlines, CRLF, BOM) is delegated to `csv-parse`; this module owns the app-specific
// glue around it: delimiter auto-detection, header sanitization (→ c0..cN), row batching with
// backpressure, progress, and cancellation. Rows are never all held in memory at once.

export interface ParsedHeader {
  columns: ColumnMap[]
  delimiter: string
}

export interface CsvParseEvents {
  onHeader: (h: ParsedHeader) => void
  /** Receives batches of raw records (variable width — pad/truncate downstream). Return false to stop. */
  onRows: (batch: string[][]) => boolean | void
  onProgress?: (bytesRead: number, rowsRead: number) => void
}

export interface ParseOptions {
  signal?: AbortSignal
  batchSize?: number
  /** Force a delimiter instead of auto-detecting from the first line. */
  delimiter?: string
}

export interface ParseResult {
  columns: ColumnMap[]
  delimiter: string
  rowsRead: number
  canceled: boolean
}

/**
 * How this file's bytes decode. Eric Zimmerman's tools emit UTF-16LE console logs, which make up a
 * good part of a KAPE package — reading those as UTF-8 yields NUL-riddled garbage, so sniff first and
 * hand the right encoding to both the delimiter probe and the parse.
 */
export function sniffEncoding(path: string): TextEncodingKind {
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const head = Buffer.alloc(8192)
    const read = readSync(fd, head, 0, head.length, 0)
    return detectEncoding(head.subarray(0, read))
  } catch {
    return 'utf8' // unreadable here will fail loudly in the real read
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* ignore */
      }
    }
  }
}

/** Read just the first line of a file (for delimiter detection), then stop reading. */
async function readFirstLine(path: string, encoding: BufferEncoding): Promise<string> {
  const stream = createReadStream(path, { encoding, highWaterMark: 64 * 1024 })
  try {
    let buf = ''
    for await (const chunk of stream as AsyncIterable<string>) {
      buf += chunk
      const nl = buf.indexOf('\n')
      if (nl !== -1) return buf.slice(0, nl).replace(/\r$/, '')
      if (buf.length > 1_000_000) return buf // pathological: a huge first line with no newline
    }
    return buf
  } finally {
    stream.destroy()
  }
}

/**
 * Stream a CSV/TSV file from disk: detect the delimiter, sanitize the header row, and emit the
 * remaining records in batches. Rows are never all held in memory at once.
 */
export async function parseCsvStream(
  path: string,
  ev: CsvParseEvents,
  opts: ParseOptions = {}
): Promise<ParseResult> {
  const { size } = await stat(path)
  const hwm = size > 500 * 1024 * 1024 ? 64 * 1024 * 1024 : 4 * 1024 * 1024
  const encoding = sniffEncoding(path)
  if (encoding === 'utf16be') throw new Error(utf16beReason(path.split(/[\\/]/).pop() ?? path))
  const readAs: BufferEncoding | undefined = encoding === 'utf16le' ? 'utf16le' : undefined
  const delimiter = opts.delimiter ?? detectDelimiter(await readFirstLine(path, readAs ?? 'utf8'))
  const batchSize = opts.batchSize ?? 5000
  // csv-parse counts what it consumed; for UTF-16LE that's decoded CHARACTERS, roughly half the
  // file's bytes — without scaling, the progress bar would stall at ~50% on those files.
  const byteScale = readAs === 'utf16le' ? 2 : 1

  // Bytes/encoding/BOM are owned by csv-parse: it reads the raw byte stream, strips a leading BOM,
  // and decodes UTF-8 into string records. We feed it Buffers (no stream encoding) and read records.
  // UTF-16LE is the exception — Node decodes it for us and csv-parse takes the resulting strings,
  // because csv-parse itself only understands UTF-8 bytes.
  const stream = createReadStream(path, { highWaterMark: hwm, ...(readAs ? { encoding: readAs } : {}) })
  const parser = parse({
    delimiter,
    bom: true, // strip a leading UTF-8 BOM (Excel/Windows CSV exports prepend it)
    relax_column_count: true, // ragged rows are fine — padded/truncated downstream
    relax_quotes: true, // tolerate stray quotes as literal text rather than failing the import
    skip_empty_lines: true // drop blank lines, but keep rows with empty fields ("1," → ["1", ""])
  })
  stream.on('error', (e) => parser.destroy(e)) // forward read errors so the iterator rejects
  stream.pipe(parser)

  let columns: ColumnMap[] | null = null
  let batch: string[][] = []
  let rowsRead = 0
  let canceled = false

  const flush = (): void => {
    if (batch.length === 0) return
    const cont = ev.onRows(batch)
    batch = []
    if (cont === false) canceled = true
    ev.onProgress?.(parser.info.bytes * byteScale, rowsRead)
  }

  try {
    for await (const rec of parser as AsyncIterable<string[]>) {
      // Cooperative cancel: a newer ingest / user abort flips the signal between records.
      if (opts.signal?.aborted) {
        canceled = true
        break
      }
      if (!columns) {
        columns = sanitizeHeaders(rec)
        ev.onHeader({ columns, delimiter })
        continue
      }
      batch.push(rec)
      rowsRead++
      if (batch.length >= batchSize) {
        flush()
        if (canceled) break
      }
    }
    if (!canceled) flush()
  } finally {
    stream.destroy()
    parser.destroy()
  }

  ev.onProgress?.(parser.info.bytes * byteScale, rowsRead)
  return { columns: columns ?? [], delimiter, rowsRead, canceled }
}
