import { useCallback, useEffect, useRef, useState } from 'react'
import type { CsvSort, CsvFilter } from '../state/csvTypes'

// Pages rows for a CSV tab over IPC. Holds one window of rows (the visible range plus
// overscan) and refetches when the grid scrolls outside it or when sort/filters change.
// Only small result sets ever cross IPC.

const OVERSCAN_ROWS = 100
const MAX_WINDOW = 1000

interface QueryState {
  rows: string[][]
  baseOffset: number
  total: number
  key: string
}

export function useCsvQuery(
  tabId: string,
  sort: CsvSort | undefined,
  filters: CsvFilter[]
): {
  rows: string[][]
  baseOffset: number
  total: number
  loading: boolean
  error?: string
  ensureRange: (first: number, last: number) => void
} {
  const key = JSON.stringify({ sort, filters })
  const [state, setState] = useState<QueryState>({ rows: [], baseOffset: 0, total: 0, key: '' })
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
        .query(tabId, { sort, filters, offset, limit })
        .then((res) => {
          if (id !== reqId.current) return // a newer request superseded this one
          setState({ rows: res.rows, baseOffset: offset, total: res.total, key })
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

  return { rows: state.rows, baseOffset: state.baseOffset, total: state.total, loading, error, ensureRange }
}
