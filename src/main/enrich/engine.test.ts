import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EnrichmentResult } from './providers/types'
import { RateLimitError } from './providers/errors'

// Mock the two modules that pull the native better-sqlite3 binding (which won't load under vitest's
// node runtime): the cache and the provider registry. We drive bulkLookup with a fake provider and
// an in-memory cache so we can assert dedupe / cache-hit / skip / abort accounting.

const { cacheGet, cachePut, lookup } = vi.hoisted(() => ({
  cacheGet: vi.fn(),
  cachePut: vi.fn(),
  lookup: vi.fn()
}))

vi.mock('./cache', () => ({
  get: (provider: string, indicators: string[]) => cacheGet(provider, indicators),
  put: (...a: unknown[]) => cachePut(...a)
}))

vi.mock('./providers', () => {
  const provider = {
    id: 'fake',
    name: 'Fake',
    kinds: ['ipv4'],
    ttlSeconds: Infinity,
    status: () => ({ ready: true, detail: 'ok' }),
    lookup
  }
  return { PROVIDERS: [provider], getProvider: (id: string) => (id === 'fake' ? provider : undefined) }
})

import { bulkLookup } from './engine'

afterEach(() => {
  cacheGet.mockReset()
  cachePut.mockReset()
  lookup.mockReset()
})

const noProgress = (): void => {}
const noAbort = (): boolean => false

describe('engine.bulkLookup', () => {
  it('dedupes repeated indicators — the provider is hit once per unique value', async () => {
    cacheGet.mockReturnValue(new Map())
    lookup.mockResolvedValue({ status: 'ok', fields: { Country: 'US' } } as EnrichmentResult)
    const res = await bulkLookup(
      'db',
      'fake',
      [
        { value: '11.22.33.44', kind: 'ipv4' },
        { value: '11.22.33.44', kind: 'ipv4' },
        { value: '12.34.56.78', kind: 'ipv4' }
      ],
      1000,
      noProgress,
      noAbort
    )
    expect(res.rows).toHaveLength(2)
    expect(lookup).toHaveBeenCalledTimes(2)
  })

  it('serves cache hits without calling the provider, and marks them fromCache', async () => {
    cacheGet.mockReturnValue(
      new Map([['11.22.33.44', { indicator: '11.22.33.44', kind: 'ipv4', status: 'ok', fields: { Country: 'US' }, fetchedAt: 0 }]])
    )
    lookup.mockResolvedValue({ status: 'ok', fields: { Country: 'AU' } } as EnrichmentResult)
    const res = await bulkLookup(
      'db',
      'fake',
      [
        { value: '11.22.33.44', kind: 'ipv4' },
        { value: '12.34.56.78', kind: 'ipv4' }
      ],
      1000,
      noProgress,
      noAbort
    )
    expect(lookup).toHaveBeenCalledTimes(1) // only the miss
    expect(res.rows.find((r) => r.indicator === '11.22.33.44')?.fromCache).toBe(true)
    expect(res.rows.find((r) => r.indicator === '12.34.56.78')?.fromCache).toBe(false)
  })

  it('skips indicator kinds the provider does not support (no lookup, status=skipped)', async () => {
    cacheGet.mockReturnValue(new Map())
    const res = await bulkLookup('db', 'fake', [{ value: 'mal-x7q2.test', kind: 'domain' }], 1000, noProgress, noAbort)
    expect(lookup).not.toHaveBeenCalled()
    expect(res.rows[0].status).toBe('skipped')
  })

  it('does not cache error results, but does cache ok/notfound', async () => {
    cacheGet.mockReturnValue(new Map())
    lookup.mockImplementation((v: string) =>
      Promise.resolve(v === '12.34.56.78' ? { status: 'error', fields: {} } : { status: 'ok', fields: { Country: 'US' } })
    )
    await bulkLookup(
      'db',
      'fake',
      [
        { value: '11.22.33.44', kind: 'ipv4' },
        { value: '12.34.56.78', kind: 'ipv4' }
      ],
      1000,
      noProgress,
      noAbort
    )
    expect(cachePut).toHaveBeenCalledTimes(1)
    const entries = cachePut.mock.calls[0][2] as Array<{ indicator: string }>
    expect(entries.map((e) => e.indicator)).toEqual(['11.22.33.44']) // the error one was not persisted
  })

  it('persists each ok result immediately (incremental writes, not one batch at the end)', async () => {
    cacheGet.mockReturnValue(new Map())
    lookup.mockResolvedValue({ status: 'ok', fields: { Country: 'US' } } as EnrichmentResult)
    await bulkLookup(
      'db',
      'fake',
      [
        { value: '11.22.33.44', kind: 'ipv4' },
        { value: '12.34.56.78', kind: 'ipv4' }
      ],
      1000,
      noProgress,
      noAbort
    )
    // Two single-entry puts (one per result), so closing the app mid-run keeps completed lookups —
    // not one batched put at the end that a crash would lose.
    expect(cachePut).toHaveBeenCalledTimes(2)
    expect((cachePut.mock.calls[0][2] as Array<{ indicator: string }>).map((e) => e.indicator)).toEqual(['11.22.33.44'])
    expect((cachePut.mock.calls[1][2] as Array<{ indicator: string }>).map((e) => e.indicator)).toEqual(['12.34.56.78'])
  })

  it('streams each finished row through onProgress (live render)', async () => {
    cacheGet.mockReturnValue(new Map())
    lookup.mockResolvedValue({ status: 'ok', fields: { Country: 'US' } } as EnrichmentResult)
    const streamed: string[] = []
    await bulkLookup(
      'db',
      'fake',
      [
        { value: '11.22.33.44', kind: 'ipv4' },
        { value: '12.34.56.78', kind: 'ipv4' }
      ],
      1000,
      (p) => {
        if (p.row) streamed.push(p.row.indicator)
      },
      noAbort
    )
    expect(streamed).toEqual(['11.22.33.44', '12.34.56.78'])
  })

  it('aborts mid-batch when shouldAbort() flips, returning canceled', async () => {
    cacheGet.mockReturnValue(new Map())
    lookup.mockResolvedValue({ status: 'ok', fields: {} } as EnrichmentResult)
    let calls = 0
    const abortAfterOne = (): boolean => calls++ >= 1
    const res = await bulkLookup(
      'db',
      'fake',
      [
        { value: '11.22.33.44', kind: 'ipv4' },
        { value: '12.34.56.78', kind: 'ipv4' }
      ],
      1000,
      noProgress,
      abortAfterOne
    )
    expect(res.canceled).toBe(true)
  })

  it('throws on an unknown provider', async () => {
    await expect(bulkLookup('db', 'nope', [], 1000, noProgress, noAbort)).rejects.toThrow(/unknown/)
  })

  it('backs off and retries once on a per-minute rate limit, then succeeds', async () => {
    cacheGet.mockReturnValue(new Map())
    lookup
      .mockRejectedValueOnce(new RateLimitError('429', { retryAfter: 0 })) // retryAfter 0 → no real wait
      .mockResolvedValueOnce({ status: 'ok', fields: { Country: 'US' } } as EnrichmentResult)
    const res = await bulkLookup('db', 'fake', [{ value: '11.22.33.44', kind: 'ipv4' }], 1000, noProgress, noAbort)
    expect(lookup).toHaveBeenCalledTimes(2)
    expect(res.rows[0].status).toBe('ok')
    expect(res.stats?.retryCount).toBe(1)
    expect(res.stats?.count429).toBe(1)
  })

  it('aborts the whole run on a daily-quota error (no per-row error spam)', async () => {
    cacheGet.mockReturnValue(new Map())
    lookup.mockRejectedValue(new RateLimitError('daily quota', { daily: true }))
    const res = await bulkLookup(
      'db',
      'fake',
      [
        { value: '11.22.33.44', kind: 'ipv4' },
        { value: '12.34.56.78', kind: 'ipv4' }
      ],
      1000,
      noProgress,
      noAbort
    )
    expect(res.aborted).toBe('quota')
    expect(res.canceled).toBe(true)
    expect(lookup).toHaveBeenCalledTimes(1) // stopped immediately; second indicator never attempted
    expect(res.rows).toHaveLength(0) // not marked as errors
  })

  it('treats a persistent rate limit (429 again after backoff) as fatal', async () => {
    cacheGet.mockReturnValue(new Map())
    lookup
      .mockRejectedValueOnce(new RateLimitError('429', { retryAfter: 0 }))
      .mockRejectedValueOnce(new RateLimitError('429 again', { retryAfter: 0 }))
    const res = await bulkLookup('db', 'fake', [{ value: '11.22.33.44', kind: 'ipv4' }], 1000, noProgress, noAbort)
    expect(lookup).toHaveBeenCalledTimes(2)
    expect(res.aborted).toBe('quota')
  })

  it('paces real lookups to the configured rolling-window rate', async () => {
    vi.useFakeTimers()
    try {
      cacheGet.mockReturnValue(new Map())
      lookup.mockResolvedValue({ status: 'ok', fields: {} } as EnrichmentResult)
      const items = [
        { value: '11.22.33.44', kind: 'ipv4' as const },
        { value: '12.34.56.78', kind: 'ipv4' as const },
        { value: '23.45.67.89', kind: 'ipv4' as const }
      ]
      // rpm=2: the first two fire immediately, the third must wait out the 60s window.
      const p = bulkLookup('db', 'fake', items, Date.now(), noProgress, noAbort, { requestsPerMinute: 2 })
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(60_000)
      const res = await p
      expect(res.rows).toHaveLength(3)
      expect(res.stats?.rateLimitSleeps).toBeGreaterThanOrEqual(1)
      expect(res.stats?.networkLookups).toBe(3)
    } finally {
      vi.useRealTimers()
    }
  })
})
