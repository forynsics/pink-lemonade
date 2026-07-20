import { describe, it, expect } from 'vitest'
import { classifyTime, detectColumnTime, timeSemantics, isEventTime, detectColumnNumeric } from './coltypes'

describe('classifyTime', () => {
  it('recognises ISO-8601 variants', () => {
    expect(classifyTime('2026-06-13T21:14:18Z')).toBe('iso')
    expect(classifyTime('2026-06-13 21:09:00')).toBe('iso')
    expect(classifyTime('2026-06-13T21:14:18.123+02:00')).toBe('iso')
    expect(classifyTime('2026-06-13')).toBe('iso')
    // fractional seconds + space before the timezone offset (e.g. .NET DateTimeOffset)
    expect(classifyTime('2023-11-14 18:04:40.954 +00:00')).toBe('iso')
    expect(classifyTime('2023-11-14 18:04:40.954 +05:30')).toBe('iso')
  })

  it('recognises epoch seconds and millis in a plausible range', () => {
    expect(classifyTime('1718313258')).toBe('epoch_s')
    expect(classifyTime('1718313258123')).toBe('epoch_ms')
  })

  it('rejects non-timestamps and out-of-range numbers', () => {
    expect(classifyTime('Jun 13 21:14:18')).toBeNull()
    expect(classifyTime('06/13/2026 21:14')).toBeNull()
    expect(classifyTime('10.47.212.3')).toBeNull()
    expect(classifyTime('0000000123')).toBeNull() // 10 digits but year ~1970
  })
})

describe('detectColumnTime', () => {
  it('detects an ISO column without a name hint', () => {
    expect(detectColumnTime(['2026-06-13T00:00:00Z', '2026-06-13T00:01:00Z', '2026-06-13T00:02:00Z'])).toBe('iso')
  })

  it('detects epoch only with a time-ish header (avoids numeric-id false positives)', () => {
    const epochs = ['1718313258', '1718313300', '1718313999']
    expect(detectColumnTime(epochs, 'event_time')).toBe('epoch_s')
    expect(detectColumnTime(epochs, 'session_id')).toBeNull()
  })

  it('returns null for mixed / mostly-non-time columns', () => {
    expect(detectColumnTime(['2026-06-13', 'banana', 'kiwi', 'mango'], 'when')).toBeNull()
  })

  it('tags a single-row source from one unambiguous ISO value (e.g. a one-row RBCmd DeletedOn)', () => {
    expect(detectColumnTime(['2023-11-09 12:18:52'], 'DeletedOn')).toBe('iso')
    expect(detectColumnTime(['2026-06-13', '', ''])).toBe('iso')
  })

  it('still needs a few samples (and a header) before trusting bare-number epochs', () => {
    expect(detectColumnTime(['1718313258'], 'event_time')).toBeNull()
    expect(detectColumnTime(['banana'])).toBeNull()
  })
})

describe('timeSemantics / isEventTime', () => {
  it('treats ordinary event timestamps as datable', () => {
    for (const l of ['Timestamp', 'Created0x10', 'UpdateTimestamp', 'UtcTime', 'Receive Time', 'RunTime'])
      expect(isEventTime(l)).toBe(true)
  })

  // CHANGED DELIBERATELY: LastModified used to count as an event time. A file's modification stamp
  // describes the FILE's history, not the action observed — a tool copied onto a host keeps its build
  // date — and rolling an event's headline span across it dated an exfiltration a month before the
  // intrusion began, ahead of the initial access that led to it.
  it('does not let a file metadata stamp date an event', () => {
    for (const l of ['LastModified', 'LastModified0x10', 'LastRecordChange0x10', 'LastWritten'])
      expect(timeSemantics(l)).toBe('metadata')
  })

  // ACCESS is an action — something opened the file. A LNK's LastAccessed IS the document-open, and
  // treating it as metadata re-dated that open to the document's own mtime years earlier.
  it('keeps access stamps as event times', () => {
    for (const l of ['LastAccessed', 'LastAccess0x10', 'Accessed']) expect(isEventTime(l)).toBe(true)
  })

  // Creation stays an EVENT: "the file appeared" is an action, and it is the right clock for a
  // dropped payload.
  it('keeps creation as an event time', () => {
    for (const l of ['Created0x10', 'CreationTime', 'Created']) expect(isEventTime(l)).toBe(true)
  })

  // Eric Zimmerman's parsers stamp these on nearly every row; SourceAccessed is effectively
  // "when KAPE collected this file", which is never when the incident happened.
  it('classifies the collection stamps EZ tools add', () => {
    for (const l of ['SourceCreated', 'SourceModified', 'SourceAccessed'])
      expect(timeSemantics(l)).toBe('collection')
  })

  // Real timestamps of the wrong thing: an RDP event dated by mstsc.exe's TargetCreated plots at
  // the OS install date rather than when the logon happened.
  it('classifies dates that belong to a referenced object', () => {
    for (const l of ['TargetCreated', 'TargetModified', 'TargetAccessed', 'LinkDate', 'CompileTime'])
      expect(timeSemantics(l)).toBe('reference')
  })

  it('normalizes spacing and casing the way real headers vary', () => {
    expect(timeSemantics('source_accessed')).toBe('collection')
    expect(timeSemantics('Target Created')).toBe('reference')
    expect(timeSemantics('SOURCEMODIFIED')).toBe('collection')
  })

  it('does not catch event columns that merely start with a similar word', () => {
    // "SourceIp"/"TargetUserName" are not times at all, but the rule must not overreach if one is.
    expect(timeSemantics('SourceIp')).toBe('event')
    expect(timeSemantics('TargetUserName')).toBe('event')
  })
})

describe('detectColumnNumeric', () => {
  // Without this, a recency rank sorts 0, 1, 10, 100, 2 — so "the most recent N" is not expressible.
  it('detects plain integer columns', () => {
    expect(detectColumnNumeric(['0', '1', '10', '100', '2'])).toBe(true)
  })

  it('detects decimals and negatives', () => {
    expect(detectColumnNumeric(['-1.5', '0', '2.25', '10'])).toBe(true)
  })

  it('ignores empty cells when judging', () => {
    expect(detectColumnNumeric(['1', '', '2', '', '3'])).toBe(true)
  })

  it('rejects text columns', () => {
    expect(detectColumnNumeric(['C:\a.exe', 'C:\b.exe', 'C:\c.exe'])).toBe(false)
    expect(detectColumnNumeric(['2023-11-14', '2023-11-15', '2023-11-16'])).toBe(false)
  })

  it('rejects a mostly-text column with a few numbers', () => {
    expect(detectColumnNumeric(['1', 'n/a', 'unknown', '3', 'error'])).toBe(false)
  })

  it('needs more than one or two values to decide', () => {
    expect(detectColumnNumeric(['7'])).toBe(false)
    expect(detectColumnNumeric(['7', '8'])).toBe(false)
  })

  // Sorting CASTs to REAL; past 2^53 that silently reorders, which is worse than sorting as text.
  it('refuses values too long to compare exactly as a number', () => {
    expect(detectColumnNumeric(['12345678901234567890', '12345678901234567891', '3'])).toBe(false)
  })

  it('tolerates a small minority of junk', () => {
    expect(detectColumnNumeric(['1', '2', '3', '4', '5', '6', '7', '8', '9', 'x'])).toBe(true)
  })
})
