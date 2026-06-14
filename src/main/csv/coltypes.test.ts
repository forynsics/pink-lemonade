import { describe, it, expect } from 'vitest'
import { classifyTime, detectColumnTime } from './coltypes'

describe('classifyTime', () => {
  it('recognises ISO-8601 variants', () => {
    expect(classifyTime('2026-06-13T21:14:18Z')).toBe('iso')
    expect(classifyTime('2026-06-13 21:09:00')).toBe('iso')
    expect(classifyTime('2026-06-13T21:14:18.123+02:00')).toBe('iso')
    expect(classifyTime('2026-06-13')).toBe('iso')
    // fractional seconds + space before the timezone offset (e.g. .NET DateTimeOffset)
    expect(classifyTime('2025-03-25 18:04:40.954 +00:00')).toBe('iso')
    expect(classifyTime('2025-03-25 18:04:40.954 +05:30')).toBe('iso')
  })

  it('recognises epoch seconds and millis in a plausible range', () => {
    expect(classifyTime('1718313258')).toBe('epoch_s')
    expect(classifyTime('1718313258123')).toBe('epoch_ms')
  })

  it('rejects non-timestamps and out-of-range numbers', () => {
    expect(classifyTime('Jun 13 21:14:18')).toBeNull()
    expect(classifyTime('06/13/2026 21:14')).toBeNull()
    expect(classifyTime('192.168.0.1')).toBeNull()
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

  it('needs at least a few non-empty samples', () => {
    expect(detectColumnTime(['2026-06-13', '', ''])).toBeNull()
  })
})
