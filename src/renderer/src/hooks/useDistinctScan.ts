import { useEffect, useRef, useState } from 'react'
import type { CsvDistinctRow, CsvFilter, CsvDistinctProgress } from '../state/csvTypes'

// Drives a chunked, cancelable distinct scan (worker-backed). Streams progress (rows scanned +
// distinct-so-far) and aborts the in-flight scan when its inputs change, the component unmounts,
// or cancel() is called. A monotonic reqId tags each scan so a stale result/progress is ignored.

let counter = 1

export interface DistinctScan {
  rows: CsvDistinctRow[]
  total: number
  truncated: boolean
  loading: boolean
  /** Live progress while scanning. */
  scanned: number
  max: number
  distinctSoFar: number
  cancel: () => void
}

export function useDistinctScan(
  tabId: string,
  col: string,
  filters: CsvFilter[] | undefined,
  limit: number,
  enabled: boolean
): DistinctScan {
  const [rows, setRows] = useState<CsvDistinctRow[]>([])
  const [total, setTotal] = useState(0)
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(false)
  const [scanned, setScanned] = useState(0)
  const [max, setMax] = useState(0)
  const [distinctSoFar, setDistinctSoFar] = useState(0)
  const reqRef = useRef(0)

  // One progress subscription; accept only ticks for this tab's current scan.
  useEffect(() => {
    return window.api.csv.onDistinctProgress((p) => {
      const ev = p as CsvDistinctProgress
      if (ev.tabId === tabId && ev.reqId === reqRef.current) {
        setScanned(ev.scanned)
        setMax(ev.max)
        setDistinctSoFar(ev.count)
      }
    })
  }, [tabId])

  const key = JSON.stringify({ tabId, col, filters, limit, enabled })
  useEffect(() => {
    if (!enabled) return
    const reqId = ++counter
    reqRef.current = reqId
    setLoading(true)
    setScanned(0)
    setDistinctSoFar(0)
    let live = true
    window.api.csv
      .distinct(tabId, col, filters, limit, reqId)
      .then((res) => {
        if (!live || reqRef.current !== reqId || 'canceled' in res) {
          if (live && reqRef.current === reqId) setLoading(false)
          return
        }
        setRows(res.rows)
        setTotal(res.total)
        setTruncated(res.truncated)
        setLoading(false)
      })
      .catch(() => live && reqRef.current === reqId && setLoading(false))
    return () => {
      live = false
      window.api.csv.distinctCancel(tabId) // abort the running scan when inputs change / unmount
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  function cancel(): void {
    reqRef.current = 0 // ignore the late result/progress for the aborted scan
    window.api.csv.distinctCancel(tabId)
    setLoading(false)
  }

  return { rows, total, truncated, loading, scanned, max, distinctSoFar, cancel }
}
