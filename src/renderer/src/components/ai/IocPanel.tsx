import { useCallback, useEffect, useMemo, useState } from 'react'
import { Fingerprint, Radar, Trash2, X } from 'lucide-react'
import type { CsvIoc } from '../../state/csvTypes'

// The case IOC catalog — a side panel listing indicators the assistant (or analyst) recorded,
// grouped by taxonomy type. Nothing here is enriched automatically; "Send to Intel" is a manual,
// per-IOC handoff to the enrichment grid (only for enrichable types).

const TYPE_LABEL: Record<string, string> = {
  ip: 'IP', domain: 'Domain', url: 'URL', email: 'Email', hash: 'File Hash',
  filename: 'Filename', filepath: 'File Path', process: 'Process', commandline: 'Command Line', useragent: 'User Agent', cloud: 'Cloud Identifier',
  registry: 'Registry', service: 'Service', scheduledtask: 'Scheduled Task', mutex: 'Mutex', namedpipe: 'Named Pipe', tlsfingerprint: 'TLS Fingerprint', certificate: 'Certificate', pdbpath: 'PDB Path'
}
const TYPE_ORDER = Object.keys(TYPE_LABEL)
const ENRICHABLE = new Set(['ip', 'domain', 'url', 'email', 'hash'])

const MIN_W = 320
const MAX_W = 640

export function IocPanel({
  open,
  onClose,
  wsId,
  refreshKey,
  onSendToIntel
}: {
  open: boolean
  onClose: () => void
  wsId: string | null
  refreshKey: number
  onSendToIntel: (values: string[]) => void
}): JSX.Element | null {
  const [iocs, setIocs] = useState<CsvIoc[]>([])
  const [width, setWidth] = useState(380)
  const [confirmClear, setConfirmClear] = useState(false)

  const reload = useCallback(async (): Promise<void> => {
    if (!wsId) {
      setIocs([])
      return
    }
    setIocs(await window.api.csv.wsIocList(wsId))
  }, [wsId])

  useEffect(() => {
    if (open) void reload()
  }, [open, reload, refreshKey])

  const grouped = useMemo(() => {
    const by = new Map<string, CsvIoc[]>()
    for (const i of iocs) {
      const arr = by.get(i.type) ?? []
      arr.push(i)
      by.set(i.type, arr)
    }
    return TYPE_ORDER.filter((t) => by.has(t)).map((t) => ({ type: t, items: by.get(t) as CsvIoc[] }))
  }, [iocs])

  const startResize = (e: React.MouseEvent): void => {
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    const onMove = (ev: MouseEvent): void => setWidth(Math.min(MAX_W, Math.max(MIN_W, startW + (startX - ev.clientX))))
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  async function del(id: string): Promise<void> {
    if (!wsId) return
    await window.api.csv.wsIocDelete(wsId, id)
    await reload()
  }
  async function clearAll(): Promise<void> {
    if (!wsId) return
    await window.api.csv.wsIocClear(wsId)
    setConfirmClear(false)
    await reload()
  }

  if (!open) return null

  const enrichable = iocs.filter((i) => ENRICHABLE.has(i.type))

  return (
    <aside
      className="ioc-panel relative flex min-h-0 shrink-0 flex-col border-l border-citrus-border bg-citrus-card dark:border-citrus-night-border dark:bg-citrus-night-card"
      style={{ width }}
    >
      <div className="absolute left-0 top-0 z-10 h-full w-1 cursor-col-resize hover:bg-citrus-pink/40" onMouseDown={startResize} title="Drag to resize" />

      <div className="flex items-center justify-between gap-2 border-b border-citrus-border px-4 py-3 dark:border-citrus-night-border">
        <div className="flex items-center gap-2 min-w-0">
          <Fingerprint className="w-4 h-4 text-citrus-pink shrink-0" />
          <div className="min-w-0">
            <div className="text-sm font-bold text-citrus-dark dark:text-citrus-night-text">IOCs</div>
            <div className="text-[11px] text-citrus-muted dark:text-citrus-night-muted">{iocs.length} catalogued</div>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {enrichable.length > 0 && (
            <button
              onClick={() => onSendToIntel(enrichable.map((i) => i.value))}
              title="Send enrichable IOCs to Intel"
              className="inline-flex items-center gap-1 rounded-md border border-citrus-border px-1.5 py-0.5 text-[11px] font-semibold text-citrus-dark hover:border-citrus-pink/40 hover:text-citrus-pink dark:border-citrus-night-border dark:text-citrus-night-text"
            >
              <Radar className="w-3.5 h-3.5" /> Send {enrichable.length} to Intel
            </button>
          )}
          {iocs.length > 0 &&
            (confirmClear ? (
              <button onClick={() => void clearAll()} title="Confirm — clear the IOC catalog" className="rounded border border-red-500/60 bg-red-500/10 px-1.5 py-0.5 text-[11px] font-semibold text-red-600 dark:border-red-400/60 dark:text-red-400">
                Clear all?
              </button>
            ) : (
              <button onClick={() => setConfirmClear(true)} title="Clear all IOCs" className="rounded p-1 text-citrus-muted hover:text-red-600 dark:text-citrus-night-muted">
                <Trash2 className="w-4 h-4" />
              </button>
            ))}
          <button onClick={onClose} title="Close" className="rounded p-1 text-citrus-muted hover:text-citrus-pink dark:text-citrus-night-muted">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {iocs.length === 0 && (
          <div className="px-2 py-6 text-center text-[12px] text-citrus-muted dark:text-citrus-night-muted">
            No IOCs yet — the Assistant catalogs indicators here.
          </div>
        )}
        {grouped.map((g) => (
          <div key={g.type} className="mb-2">
            <div className="px-1 pb-1 text-[10px] font-bold uppercase tracking-wide text-citrus-muted dark:text-citrus-night-muted">
              {TYPE_LABEL[g.type] ?? g.type} <span className="text-citrus-muted/60">· {g.items.length}</span>
            </div>
            <div className="space-y-0.5">
              {g.items.map((i) => (
                <div key={i.id} className="group flex items-center gap-2 rounded-md px-2 py-1 text-[12px] hover:bg-citrus-sand/50 dark:hover:bg-citrus-night-elev">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-citrus-dark dark:text-citrus-night-text" title={i.value}>
                      {i.value}
                    </div>
                    {i.context && <div className="truncate text-[10px] text-citrus-muted dark:text-citrus-night-muted">{i.context}</div>}
                  </div>
                  {ENRICHABLE.has(i.type) && (
                    <button
                      onClick={() => onSendToIntel([i.value])}
                      title="Send to Intel"
                      className="shrink-0 text-citrus-muted hover:text-citrus-pink dark:text-citrus-night-muted"
                    >
                      <Radar className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <button onClick={() => void del(i.id)} title="Remove" className="shrink-0 text-citrus-muted opacity-0 group-hover:opacity-100 hover:text-red-600 dark:text-citrus-night-muted">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </aside>
  )
}
