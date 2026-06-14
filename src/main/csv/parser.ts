import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
import { detectDelimiter, sanitizeHeaders, type ColumnMap } from './sanitize'

// Streaming, quote-aware CSV/TSV parser.
//
// `CsvRecordParser` is a pure incremental state machine (push chunks → get completed
// records) — it carries quote/field state across chunk boundaries, so a quoted field
// containing the delimiter or a newline that straddles a read boundary parses correctly.
// `parseCsvStream` wraps it around fs.createReadStream and emits a header + batched rows.

export class CsvRecordParser {
  private readonly delim: string
  private field = ''
  private row: string[] = []
  private rowHasContent = false
  private inQuotes = false
  // We saw a `"` that *might* close a quoted field — but if the next char is also `"`
  // it's an escaped quote. Resolved on the following char (possibly in the next chunk).
  private maybeClosingQuote = false

  constructor(delimiter: string) {
    this.delim = delimiter
  }

  /** Feed a chunk; return any records completed by it. */
  push(chunk: string): string[][] {
    const out: string[][] = []
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i]

      if (this.maybeClosingQuote) {
        this.maybeClosingQuote = false
        if (ch === '"') {
          // escaped quote ("") inside a quoted field
          this.field += '"'
          this.inQuotes = true
          this.rowHasContent = true
          continue
        }
        // otherwise the quote closed the field; fall through to handle ch unquoted
      }

      if (this.inQuotes) {
        if (ch === '"') {
          // tentatively close — resolved on the next char (escaped "" vs real close)
          this.inQuotes = false
          this.maybeClosingQuote = true
        } else {
          this.field += ch
        }
        continue
      }

      if (ch === '"') {
        this.inQuotes = true
        this.rowHasContent = true
      } else if (ch === this.delim) {
        this.endField()
      } else if (ch === '\n') {
        this.endRecord(out)
      } else if (ch === '\r') {
        // ignore CR; the following LF terminates the record (CRLF), and a lone CR is rare
      } else {
        this.field += ch
        this.rowHasContent = true
      }
    }
    return out
  }

  /** Flush a trailing record with no terminating newline. */
  end(): string[][] {
    const out: string[][] = []
    if (this.field !== '' || this.row.length > 0 || this.rowHasContent) {
      this.endRecord(out)
    }
    return out
  }

  private endField(): void {
    this.row.push(this.field)
    this.field = ''
  }

  private endRecord(out: string[][]): void {
    this.row.push(this.field)
    this.field = ''
    // skip fully-blank lines (a single empty field with no other content)
    if (!(this.row.length === 1 && this.row[0] === '' && !this.rowHasContent)) {
      out.push(this.row)
    }
    this.row = []
    this.rowHasContent = false
  }
}

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
  /** Force a delimiter instead of auto-detecting. */
  delimiter?: string
}

export interface ParseResult {
  columns: ColumnMap[]
  delimiter: string
  rowsRead: number
  canceled: boolean
}

/**
 * Stream a CSV file from disk: detect the delimiter, sanitize the header row, and emit
 * the remaining records in batches. Rows are never all held in memory at once.
 */
export async function parseCsvStream(
  path: string,
  ev: CsvParseEvents,
  opts: ParseOptions = {}
): Promise<ParseResult> {
  const { size } = await stat(path)
  const hwm = size > 500 * 1024 * 1024 ? 64 * 1024 * 1024 : 4 * 1024 * 1024
  const stream = createReadStream(path, { encoding: 'utf8', highWaterMark: hwm })

  const batchSize = opts.batchSize ?? 5000
  let parser: CsvRecordParser | null = null
  let columns: ColumnMap[] | null = null
  let delimiter = opts.delimiter ?? ','
  let headerBuf = ''
  let batch: string[][] = []
  let rowsRead = 0
  let bytesRead = 0
  let canceled = false

  const flush = (): void => {
    if (batch.length === 0) return
    const cont = ev.onRows(batch)
    batch = []
    if (cont === false) canceled = true
  }

  const consume = (records: string[][]): void => {
    for (const rec of records) {
      if (!columns) {
        columns = sanitizeHeaders(rec)
        ev.onHeader({ columns, delimiter })
        continue
      }
      batch.push(rec)
      rowsRead++
      if (batch.length >= batchSize) {
        flush()
        if (canceled) return
      }
    }
  }

  for await (const chunk of stream as AsyncIterable<string>) {
    bytesRead += Buffer.byteLength(chunk)
    if (opts.signal?.aborted) canceled = true
    if (canceled) break

    if (!parser) {
      headerBuf += chunk
      const nl = headerBuf.indexOf('\n')
      if (nl === -1) continue // need more data to read the first line
      const firstLine = headerBuf.slice(0, nl).replace(/\r$/, '')
      delimiter = opts.delimiter ?? detectDelimiter(firstLine)
      parser = new CsvRecordParser(delimiter)
      consume(parser.push(headerBuf))
      headerBuf = ''
    } else {
      consume(parser.push(chunk))
    }
    ev.onProgress?.(bytesRead, rowsRead)
    if (canceled) break
  }

  if (!canceled) {
    if (parser) {
      consume(parser.end())
    } else if (headerBuf.length > 0) {
      // whole file was a single line (header only, no data rows)
      delimiter = opts.delimiter ?? detectDelimiter(headerBuf.replace(/\r?\n?$/, ''))
      parser = new CsvRecordParser(delimiter)
      consume(parser.push(headerBuf).concat(parser.end()))
    }
    flush()
  }

  if (canceled) stream.destroy()
  ev.onProgress?.(bytesRead, rowsRead)
  return { columns: columns ?? [], delimiter, rowsRead, canceled }
}
