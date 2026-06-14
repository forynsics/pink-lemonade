import { useCallback, useEffect, useRef, useState } from 'react'
import type { CsvSort, CsvFilter, CsvCountProgress } from '../state/csvTypes'

// Pages rows for a CSV tab over IPC. Holds one window of rows (the visible range plus
// overscan) and refetches when the grid scrolls outside it or when sort/filters change.
// Only small result sets ever cross IPC.
//
// The match COUNT is decoupled from the window fetch (Scale #2): the row window never counts, so
// scrolling is cheap even on a 30GB table. The unfiltered total is the known row count (free).
// A filtered/searched total is computed by a chunked, cancelable counter in main that streams its
// running total back over `onCountProgress` — so the count fills in live without blocking scroll.

const OVERSCAN_ROWS = 100
const MAX_WINDOW = 1000

interface WindowState {
  rows: string[][]
  rids: number[]
  baseOffset: number
  key: string
}

export function useCsvQuery(
  tabId: string,
  rowCount: number,
  sort: CsvSort | undefined,
  filters: CsvFilter[],
  search: string
): {
  rows: string[][]
  rids: number[]
  baseOffset: number
  total: number
  counting: boolean
  loading: boolean
  error?: string
  ensureRange: (first: number, last: number) => void
} {
  const key = JSON.stringify({ sort, filters, search })
  const [state, setState] = useState<WindowState>({ rows: [], rids: [], baseOffset: 0, key: '' })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const reqId = useRef(0)
  const stateRef = useRef(state)
  stateRef.current = state

  const fetchWindow = useCallback(
    (offset: number, limit: number) => {
      const id = ++reqId.current
      setLoading(true)
      window.api.csv
        .query(tabId, { sort, filters, search, offset, limit })
        .then((res) => {
          if (id !== reqId.current) return // a newer request superseded this one
          setState({ rows: res.rows, rids: res.rids ?? [], baseOffset: offset, key })
          setError(undefined)
        })
        .catch((e) => {
          if (id === reqId.current) setError(String(e?.message ?? e))
        })
        .finally(() => {
          if (id === reqId.current) setLoading(false)
        })
    },
    // `sort`/`filters` are captured via `key`; refetch identity changes when they do
    [tabId, key] // eslint-disable-line react-hooks/exhaustive-deps
  )

  // Load the first window on mount and whenever the tab or sort/filters change.
  useEffect(() => {
    fetchWindow(0, 200)
  }, [fetchWindow])

  const ensureRange = useCallback(
    (first: number, last: number) => {
      const s = stateRef.current
      const haveStart = s.baseOffset
      const haveEnd = s.baseOffset + s.rows.length
      if (s.key === key && first >= haveStart && last < haveEnd) return // already loaded
      const start = Math.max(0, first - OVERSCAN_ROWS)
      const limit = Math.min(MAX_WINDOW, last + OVERSCAN_ROWS - start + 1)
      fetchWindow(start, limit)
    },
    [key, fetchWindow]
  )

  // --- match count (decoupled from the window fetch) ---
  const hasPredicate = filters.length > 0 || search !== ''
  const countKey = JSON.stringify({ filters, search }) // sort doesn't change the count
  const [countTotal, setCountTotal] = useState(0)
  const [counting, setCounting] = useState(false)
  const countReq = useRef(0)
  // The reqId whose progress events we currently accept (null when unfiltered).
  const activeCountReq = useRef<number | null>(null)

  // Apply live partial counts (the scrollbar grows as the counter scans).
  useEffect(() => {
    return window.api.csv.onCountProgress((p) => {
      const ev = p as CsvCountProgress
      if (ev.tabId === tabId && ev.reqId === activeCountReq.current) setCountTotal(ev.count)
    })
  }, [tabId])

  useEffect(() => {
    if (!hasPredicate) {
      activeCountReq.current = null
      setCounting(false)
      setCountTotal(0)
      return
    }
    const rid = ++countReq.current
    activeCountReq.current = rid
    setCountTotal(0)
    setCounting(true)
    window.api.csv
      .count(tabId, rid, filters, search)
      .then((res) => {
        if (countReq.current !== rid) return // superseded
        if ('count' in res) setCountTotal(res.count)
        setCounting(false)
      })
      .catch(() => {
        if (countReq.current === rid) setCounting(false)
      })
    // A newer count (or switching to unfiltered) supersedes this one; main aborts it via reqId.
  }, [tabId, countKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // While a filtered count is still running, keep the total at least as large as the loaded window
  // so the grid can render what we have; it grows toward the true count as partials arrive.
  const loadedEnd = state.baseOffset + state.rows.length
  const total = hasPredicate ? Math.max(countTotal, loadedEnd) : rowCount

  return { rows: state.rows, rids: state.rids, baseOffset: state.baseOffset, total, counting, loading, error, ensureRange }
}
