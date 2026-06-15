import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EnrichmentResult } from './providers/types'

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
        { value: '8.8.8.8', kind: 'ipv4' },
        { value: '8.8.8.8', kind: 'ipv4' },
        { value: '1.1.1.1', kind: 'ipv4' }
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
      new Map([['8.8.8.8', { indicator: '8.8.8.8', kind: 'ipv4', status: 'ok', fields: { Country: 'US' }, fetchedAt: 0 }]])
    )
    lookup.mockResolvedValue({ status: 'ok', fields: { Country: 'AU' } } as EnrichmentResult)
    const res = await bulkLookup(
      'db',
      'fake',
      [
        { value: '8.8.8.8', kind: 'ipv4' },
        { value: '1.1.1.1', kind: 'ipv4' }
      ],
      1000,
      noProgress,
      noAbort
    )
    expect(lookup).toHaveBeenCalledTimes(1) // only the miss
    expect(res.rows.find((r) => r.indicator === '8.8.8.8')?.fromCache).toBe(true)
    expect(res.rows.find((r) => r.indicator === '1.1.1.1')?.fromCache).toBe(false)
  })

  it('skips indicator kinds the provider does not support (no lookup, status=skipped)', async () => {
    cacheGet.mockReturnValue(new Map())
    const res = await bulkLookup('db', 'fake', [{ value: 'evil.com', kind: 'domain' }], 1000, noProgress, noAbort)
    expect(lookup).not.toHaveBeenCalled()
    expect(res.rows[0].status).toBe('skipped')
  })

  it('does not cache error results, but does cache ok/notfound', async () => {
    cacheGet.mockReturnValue(new Map())
    lookup.mockImplementation((v: string) =>
      Promise.resolve(v === '1.1.1.1' ? { status: 'error', fields: {} } : { status: 'ok', fields: { Country: 'US' } })
    )
    await bulkLookup(
      'db',
      'fake',
      [
        { value: '8.8.8.8', kind: 'ipv4' },
        { value: '1.1.1.1', kind: 'ipv4' }
      ],
      1000,
      noProgress,
      noAbort
    )
    expect(cachePut).toHaveBeenCalledTimes(1)
    const entries = cachePut.mock.calls[0][2] as Array<{ indicator: string }>
    expect(entries.map((e) => e.indicator)).toEqual(['8.8.8.8']) // the error one was not persisted
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
        { value: '8.8.8.8', kind: 'ipv4' },
        { value: '1.1.1.1', kind: 'ipv4' }
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
})
