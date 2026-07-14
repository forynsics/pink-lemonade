import { useEffect, useMemo, useState } from 'react'
import { Braces, Loader2, Plus, X } from 'lucide-react'
import type { CsvColumn } from '../../state/csvTypes'
import { discoverScalarPaths, type JsonField } from '../../state/jsonPaths'

// Pull scalar sub-fields of a JSON column (e.g. O365 `AuditData`) into new first-class grid columns —
// the in-app version of "expand the JSON in Excel". Samples the column, discovers its top-level keys,
// and lets the analyst pick scalars (or add them all). Nested arrays/objects are shown but not
// offered (they'd stay JSON text); a custom JSON-path input covers deeper fields. Mirrors
// RecordEventDialog's modal shell. The parent runs the extraction (onSubmit) + appends the columns.

const SAMPLE_ROWS = 120

const field =
  'w-full rounded border border-citrus-border bg-citrus-bg px-2 py-1 text-[11px] text-citrus-dark outline-none focus:border-citrus-pink/60 dark:border-citrus-night-border dark:bg-citrus-night-bg dark:text-citrus-night-text'

export function JsonExtractDialog({
  tabId,
  col,
  onSubmit,
  onClose
}: {
  tabId: string
  /** The JSON source column to extract from. */
  col: CsvColumn
  /** Run the extraction (parent calls the IPC + appends the returned columns). Resolves on success. */
  onSubmit: (fields: Array<{ path: string; displayName: string }>) => Promise<void>
  onClose: () => void
}): JSX.Element {
  const [loading, setLoading] = useState(true)
  const [fields, setFields] = useState<JsonField[]>([])
  const [custom, setCustom] = useState<JsonField[]>([]) // power-user custom paths, auto-selected
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [names, setNames] = useState<Record<string, string>>({})
  const [customPath, setCustomPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Sample the column's values and discover its JSON shape. Rows arrive c0..cN; pull this column by
  // its stable positional index.
  useEffect(() => {
    let live = true
    const idx = Number(col.name.slice(1))
    void window.api.csv.query(tabId, { limit: SAMPLE_ROWS, offset: 0 }).then((res) => {
      if (!live) return
      const samples = res.rows.map((r) => r[idx] ?? '').filter((v) => v.trim() !== '')
      setFields(discoverScalarPaths(samples))
      setLoading(false)
    })
    return () => {
      live = false
    }
  }, [tabId, col.name])

  const scalars = useMemo(() => [...fields.filter((f) => f.kind === 'scalar'), ...custom], [fields, custom])
  const nonScalars = useMemo(() => fields.filter((f) => f.kind !== 'scalar'), [fields])

  function toggle(path: string): void {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }
  function nameFor(f: JsonField): string {
    return names[f.path] ?? f.key
  }
  function addAll(): void {
    setSelected(new Set(scalars.map((f) => f.path)))
  }
  function addCustom(): void {
    const p = customPath.trim()
    if (!p) return
    const path = p.startsWith('$') ? p : `$.${p}`
    if (scalars.some((f) => f.path === path)) {
      setSelected((prev) => new Set(prev).add(path))
      setCustomPath('')
      return
    }
    // Derive a key from the trailing path segment for the default display name.
    const key = path.replace(/^\$\.?/, '').replace(/[[\]"]/g, '').split('.').pop() || path
    setCustom((prev) => [...prev, { path, key, kind: 'scalar', example: 'custom path' }])
    setSelected((prev) => new Set(prev).add(path))
    setCustomPath('')
  }

  async function submit(): Promise<void> {
    const chosen = scalars.filter((f) => selected.has(f.path))
    if (chosen.length === 0) return
    setBusy(true)
    setError(null)
    try {
      await onSubmit(chosen.map((f) => ({ path: f.path, displayName: nameFor(f).trim() || f.key })))
      // Parent closes the dialog on success.
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25" onClick={onClose}>
      <div
        className="flex max-h-[80vh] w-[min(560px,92vw)] flex-col rounded-xl border border-citrus-border bg-citrus-card shadow-lg dark:border-citrus-night-border dark:bg-citrus-night-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-citrus-border px-4 py-2.5 dark:border-citrus-night-border">
          <span className="inline-flex items-center gap-1.5 text-xs font-bold text-citrus-dark dark:text-citrus-night-text">
            <Braces className="h-3.5 w-3.5 text-citrus-pink" /> Extract JSON fields from{' '}
            <span className="font-mono">{col.original}</span>
          </span>
          <button onClick={onClose} title="Close (Esc)" className="text-citrus-muted hover:text-citrus-pink">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-col gap-2.5 overflow-auto p-4">
          <div className="text-[11px] text-citrus-muted dark:text-citrus-night-muted">
            New grid columns you can filter, sort, and sweep — added alongside the source data.
          </div>

          {loading ? (
            <div className="flex items-center gap-2 py-8 text-[12px] text-citrus-muted dark:text-citrus-night-muted">
              <Loader2 className="h-4 w-4 animate-spin text-citrus-pink" /> Sampling the column…
            </div>
          ) : scalars.length === 0 && nonScalars.length === 0 ? (
            <div className="py-6 text-center text-[12px] text-citrus-muted dark:text-citrus-night-muted">
              No JSON fields detected in this column.
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-bold uppercase tracking-wide text-citrus-muted dark:text-citrus-night-muted">
                  {scalars.length} field{scalars.length === 1 ? '' : 's'} · {selected.size} selected
                </span>
                <button
                  onClick={addAll}
                  disabled={scalars.length === 0}
                  className="text-[11px] font-bold text-citrus-pink hover:underline disabled:opacity-40"
                >
                  Add all
                </button>
              </div>

              <div className="flex flex-col divide-y divide-citrus-border/50 rounded border border-citrus-border dark:divide-citrus-night-border/50 dark:border-citrus-night-border">
                {scalars.map((f) => {
                  const on = selected.has(f.path)
                  return (
                    <div key={f.path} className="flex items-center gap-2 px-2.5 py-1.5">
                      <input type="checkbox" checked={on} onChange={() => toggle(f.path)} className="accent-citrus-pink" />
                      <button onClick={() => toggle(f.path)} className="flex min-w-0 flex-1 flex-col items-start text-left">
                        <span className="font-mono text-[11px] text-citrus-dark dark:text-citrus-night-text">{f.key}</span>
                        <span className="truncate text-[10px] text-citrus-muted dark:text-citrus-night-muted">{f.example}</span>
                      </button>
                      {on && (
                        <input
                          value={nameFor(f)}
                          onChange={(e) => setNames((m) => ({ ...m, [f.path]: e.target.value }))}
                          title="Column name"
                          className={`${field} w-36 shrink-0`}
                        />
                      )}
                    </div>
                  )
                })}
                {scalars.length === 0 && (
                  <div className="px-2.5 py-2 text-[11px] text-citrus-muted dark:text-citrus-night-muted">
                    No scalar fields — add a custom path below.
                  </div>
                )}
              </div>

              {nonScalars.length > 0 && (
                <div className="text-[10px] text-citrus-muted dark:text-citrus-night-muted">
                  Kept as JSON text:{' '}
                  {nonScalars.map((f) => (
                    <span key={f.path} className="mr-1.5 font-mono">
                      {f.key} ({f.kind})
                    </span>
                  ))}
                </div>
              )}

              {/* Advanced: a custom JSON path for a nested/sparse field (e.g. $.OperationProperties). */}
              <div className="flex items-center gap-1.5">
                <input
                  value={customPath}
                  onChange={(e) => setCustomPath(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') addCustom()
                  }}
                  placeholder="Custom JSON path — e.g. $.ResultStatus"
                  className={field}
                />
                <button
                  onClick={addCustom}
                  disabled={!customPath.trim()}
                  className="inline-flex shrink-0 items-center gap-1 rounded-md border border-citrus-pink/40 px-2 py-1 text-[11px] font-bold text-citrus-pink hover:bg-citrus-pink-light disabled:opacity-40 dark:hover:bg-citrus-night-elev"
                >
                  <Plus className="h-3 w-3" /> Add
                </button>
              </div>
            </>
          )}

          {error && <div className="text-[11px] font-semibold text-red-600 dark:text-red-400">{error}</div>}
        </div>

        <div className="flex justify-end gap-2 border-t border-citrus-border px-4 py-2.5 dark:border-citrus-night-border">
          <button
            onClick={onClose}
            className="rounded-md border border-citrus-border px-3 py-1 text-[11px] font-bold text-citrus-dark hover:bg-citrus-sand/60 dark:border-citrus-night-border dark:text-citrus-night-text dark:hover:bg-citrus-night-elev"
          >
            Cancel
          </button>
          <button
            onClick={() => void submit()}
            disabled={selected.size === 0 || busy}
            className="inline-flex items-center gap-1.5 rounded-md bg-citrus-pink px-3 py-1 text-[11px] font-bold text-white hover:bg-citrus-pink-hover disabled:opacity-40"
          >
            {busy && <Loader2 className="h-3 w-3 animate-spin" />}
            {busy ? 'Extracting…' : `Extract ${selected.size || ''} field${selected.size === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  )
}
