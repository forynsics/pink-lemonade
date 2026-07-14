import { useState } from 'react'
import { ChevronRight } from 'lucide-react'

// Read-only collapsible JSON tree for the cell popout's "Pretty" view. Objects/arrays collapse with
// a ▸ caret (the first couple of levels auto-expand); scalars render inline, typed by colour. Pure
// presentational — the caller parses + guards (only mounts this when JSON.parse succeeded).

export function JsonView({ data }: { data: unknown }): JSX.Element {
  return (
    <div className="font-mono text-xs leading-relaxed text-citrus-dark dark:text-citrus-night-text select-text">
      <JsonNode value={data} name={null} depth={0} />
    </div>
  )
}

function JsonNode({ value, name, depth }: { value: unknown; name: string | null; depth: number }): JSX.Element {
  const isArr = Array.isArray(value)
  const isObj = value !== null && typeof value === 'object' && !isArr
  const [open, setOpen] = useState(depth < 2) // auto-expand the top couple of levels
  const pad = { paddingLeft: depth * 14 }

  const key =
    name != null ? (
      <>
        <span className="text-citrus-pink">{name}</span>
        <span className="text-citrus-muted dark:text-citrus-night-muted">:</span>{' '}
      </>
    ) : null

  if (!isArr && !isObj) {
    return (
      <div className="px-1" style={pad}>
        {key}
        <Scalar value={value} />
      </div>
    )
  }

  const entries = isArr
    ? (value as unknown[]).map((v, i) => [String(i), v] as const)
    : Object.entries(value as Record<string, unknown>)
  const summary = isArr ? `Array[${entries.length}]` : `{${entries.length}}`

  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1 px-1 rounded text-left hover:bg-citrus-pink-light/50 dark:hover:bg-citrus-night-elev"
        style={pad}
      >
        <ChevronRight className={`w-3 h-3 shrink-0 text-citrus-muted transition-transform ${open ? 'rotate-90' : ''}`} />
        {key}
        <span className="text-citrus-muted dark:text-citrus-night-muted">{summary}</span>
      </button>
      {open &&
        entries.map(([k, v]) => <JsonNode key={k} name={isArr ? `[${k}]` : k} value={v} depth={depth + 1} />)}
    </div>
  )
}

function Scalar({ value }: { value: unknown }): JSX.Element {
  if (value === null) return <span className="text-citrus-muted italic dark:text-citrus-night-muted">null</span>
  if (typeof value === 'number' || typeof value === 'boolean')
    return <span className="text-sky-700 dark:text-sky-400">{String(value)}</span>
  // strings — shown quoted, break long values (URLs, message-ids) instead of overflowing
  return <span className="text-emerald-700 break-all dark:text-emerald-400">{JSON.stringify(value)}</span>
}
