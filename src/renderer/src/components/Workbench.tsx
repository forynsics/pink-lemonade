import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ChevronDown, ChevronUp, Copy, Download, FolderOpen, Loader2, Radar, Search, X } from 'lucide-react'
import type { WorkflowResult } from '../state/workflow'
import { iocMetrics, type IocMetrics } from '../state/metrics'
import { CodeArea, type CodeAreaMeta } from './CodeArea'

// Above this output size, IOC counts (six global-regex passes) aren't computed live —
// the user can trigger them on demand. Char count stays free.
const METRICS_MAX = 2_000_000
// Files larger than this warn before opening (they may be slow to open/edit).
const WARN_BYTES = 1024 ** 3

function fmtSize(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
}

/** Resolve after the next paint (double rAF) so a just-shown overlay is composited
 *  before we run a blocking state update. */
function nextPaint(): Promise<void> {
  return new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  )
}

/** One-line cursor/size summary for a pane's status bar (Notepad++-style). */
function metaText(m: CodeAreaMeta | null): string {
  if (!m) return ''
  const w = m.words === null ? '—' : m.words.toLocaleString()
  return `Ln ${m.line.toLocaleString()}, Col ${m.col.toLocaleString()} · ${m.lines.toLocaleString()} lines · ${w} words · ${m.chars.toLocaleString()} chars`
}

function IocStat({ label, n, tone }: { label: string; n: number; tone: string }): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="uppercase tracking-wide text-citrus-muted/80 dark:text-citrus-night-muted/80">{label}</span>
      <strong className={n > 0 ? tone : 'text-citrus-muted dark:text-citrus-night-muted'}>{n}</strong>
    </span>
  )
}

export function Workbench({
  input,
  onInput,
  result,
  active = true,
  onSendToEnrichment
}: {
  input: string
  onInput: (v: string) => void
  result: WorkflowResult
  /** Whether this is the visible/active editor — only the active one handles the Ctrl+F shortcut
   *  (every scratch doc keeps a mounted Workbench, so the window listener must be gated). */
  active?: boolean
  /** Send the output's indicators to the Enrichment tab (classified + deduped by the parent). */
  onSendToEnrichment?: (values: string[]) => void
}): JSX.Element {
  const [copied, setCopied] = useState(false)
  const [wrap, setWrap] = useState(true)
  const [loading, setLoading] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [manualIoc, setManualIoc] = useState<IocMetrics | null>(null)
  // Per-pane cursor/size metrics for the status bars (reported up from each CodeArea).
  const [inputMeta, setInputMeta] = useState<CodeAreaMeta | null>(null)
  const [outputMeta, setOutputMeta] = useState<CodeAreaMeta | null>(null)
  const onInputMeta = useCallback((m: CodeAreaMeta) => setInputMeta(m), [])
  const onOutputMeta = useCallback((m: CodeAreaMeta) => setOutputMeta(m), [])

  const out = result.output
  const iocTooBig = out.length > METRICS_MAX

  // --- Ctrl+F find (searches whichever pane had focus when invoked) ---
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const outputRef = useRef<HTMLTextAreaElement>(null)
  const findInputRef = useRef<HTMLInputElement>(null)
  const [find, setFind] = useState<{ target: 'input' | 'output' } | null>(null)
  const [findTerm, setFindTerm] = useState('')
  const [matchIdx, setMatchIdx] = useState(0)

  const targetText = find?.target === 'output' ? out : input
  const matches = useMemo(() => {
    if (!find || findTerm === '') return []
    const res: number[] = []
    const hay = targetText.toLowerCase()
    const needle = findTerm.toLowerCase()
    let i = hay.indexOf(needle)
    while (i !== -1) {
      res.push(i)
      i = hay.indexOf(needle, i + needle.length)
    }
    return res
  }, [find, findTerm, targetText])

  // Select the match in the target textarea (shown greyed since focus stays in the find box);
  // CodeArea scrolls the active match into view off the highlight prop. Find input keeps focus
  // so Enter keeps stepping.
  const selectMatch = useCallback(
    (i: number) => {
      if (!find || i < 0 || i >= matches.length) return
      const ta = find.target === 'output' ? outputRef.current : inputRef.current
      if (!ta) return
      const start = matches[i]
      ta.setSelectionRange(start, start + findTerm.length)
    },
    [find, matches, findTerm]
  )

  function stepFind(dir: 1 | -1): void {
    if (matches.length === 0) return
    const next = (matchIdx + dir + matches.length) % matches.length
    setMatchIdx(next)
    selectMatch(next)
  }

  function closeFind(): void {
    setFind(null)
    setFindTerm('')
    setMatchIdx(0)
  }

  // As the term (or target text) changes, jump to the first match.
  useEffect(() => {
    if (!find || matches.length === 0) return
    setMatchIdx(0)
    selectMatch(0)
  }, [matches]) // eslint-disable-line react-hooks/exhaustive-deps

  // Ctrl/Cmd+F opens the find bar over the focused pane (this component only mounts for the
  // notepad, so the listener is naturally scoped to it).
  useEffect(() => {
    if (!active) return // only the visible editor responds to Ctrl+F
    const onKey = (e: KeyboardEvent): void => {
      if (!((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F'))) return
      e.preventDefault()
      setFind((cur) => {
        if (cur) return cur // already open — keep current target
        return { target: document.activeElement === outputRef.current ? 'output' : 'input' }
      })
      requestAnimationFrame(() => findInputRef.current?.select())
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active])

  // A fresh output invalidates any on-demand IOC count.
  useEffect(() => setManualIoc(null), [out])

  // Live counts for normal output; for large output show the on-demand result (or nothing).
  const im = useMemo(() => (iocTooBig ? manualIoc : iocMetrics(out)), [iocTooBig, manualIoc, out])

  const pill =
    'px-2.5 py-1 rounded-md text-[11px] font-bold text-citrus-muted hover:bg-citrus-sand/60 transition-colors dark:text-citrus-night-muted dark:hover:bg-citrus-night-elev'
  const pillActive =
    'px-2.5 py-1 rounded-md text-[11px] font-bold bg-citrus-pink-light text-citrus-pink border border-citrus-pink/20'
  const cardClass =
    'relative flex flex-col min-h-0 min-w-0 rounded-xl border border-citrus-border bg-citrus-card p-3 shadow-sm dark:border-citrus-night-border dark:bg-citrus-night-card'

  async function copyOutput(): Promise<void> {
    try {
      await navigator.clipboard.writeText(out)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      /* clipboard unavailable; ignore */
    }
  }

  async function loadFile(): Promise<void> {
    setLoadError(null)
    const file = await window.api?.openFile()
    if (!file) return
    if (file.tooLarge) {
      setLoadError(`"${file.name}" is too large to open as a single buffer (${fmtSize(file.size)}).`)
      return
    }
    if (
      file.size > WARN_BYTES &&
      !window.confirm(
        `"${file.name}" is ${fmtSize(file.size)}. Large files may be slow to open and edit. Open anyway?`
      )
    ) {
      return
    }
    setLoading(`Loading ${fmtSize(file.size)}…`)
    await nextPaint() // let the spinner paint before the blocking commit
    onInput(file.content)
    await nextPaint() // keep the spinner up through the heavy render, then clear it
    setLoading(null)
  }

  async function saveFile(): Promise<void> {
    await window.api?.saveFile(out)
  }

  return (
    <div className="relative flex-1 grid grid-cols-2 gap-3 p-3 min-h-0 bg-citrus-cream/30 dark:bg-citrus-night">
      {find && (
        <div className="find-bar absolute top-4 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 rounded-lg border border-citrus-border bg-citrus-card px-2.5 py-1.5 shadow-lg dark:border-citrus-night-border dark:bg-citrus-night-card">
          <Search className="w-3.5 h-3.5 text-citrus-muted dark:text-citrus-night-muted" />
          <span className="text-[10px] font-bold uppercase tracking-wide text-citrus-muted dark:text-citrus-night-muted">
            {find.target}
          </span>
          <input
            ref={findInputRef}
            autoFocus
            value={findTerm}
            onChange={(e) => setFindTerm(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') closeFind()
              else if (e.key === 'Enter') {
                e.preventDefault()
                stepFind(e.shiftKey ? -1 : 1)
              }
            }}
            placeholder="Find…"
            spellCheck={false}
            className="w-44 px-1.5 py-0.5 text-xs rounded border border-citrus-border bg-citrus-cream text-citrus-dark outline-none focus:border-citrus-pink dark:border-citrus-night-border dark:bg-citrus-night dark:text-citrus-night-text"
          />
          <span className="text-[11px] font-mono text-citrus-muted dark:text-citrus-night-muted whitespace-nowrap min-w-[44px] text-center">
            {findTerm === '' ? '' : matches.length === 0 ? 'none' : `${matchIdx + 1} / ${matches.length}`}
          </span>
          <button
            onClick={() => stepFind(-1)}
            title="Previous (Shift+Enter)"
            className="text-citrus-muted hover:text-citrus-pink dark:text-citrus-night-muted"
          >
            <ChevronUp className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => stepFind(1)}
            title="Next (Enter)"
            className="text-citrus-muted hover:text-citrus-pink dark:text-citrus-night-muted"
          >
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={closeFind}
            title="Close (Esc)"
            className="text-citrus-muted hover:text-citrus-pink dark:text-citrus-night-muted"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
      {/* INPUT */}
      <div className={cardClass}>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-citrus-yellow" />
            <h4 className="text-xs font-bold uppercase tracking-wider text-citrus-dark dark:text-citrus-night-text">Input</h4>
          </div>
          <div className="flex items-center gap-1">
            <button className={wrap ? pillActive : pill} onClick={() => setWrap((w) => !w)} title="Toggle word wrap">
              Wrap
            </button>
            <button className={pill} onClick={loadFile}>
              <span className="inline-flex items-center gap-1"><FolderOpen className="w-3 h-3" /> Open…</span>
            </button>
            <button className={pill} onClick={() => onInput('')}>
              Clear
            </button>
          </div>
        </div>
        {loadError && (
          <div className="mb-2 text-[11px] font-medium text-citrus-pink-hover">{loadError}</div>
        )}
        <CodeArea
          ref={inputRef}
          className="pane__text"
          value={input}
          onChange={onInput}
          wrap={wrap}
          placeholder="Paste data here…"
          highlight={find?.target === 'input' ? { term: findTerm, active: matches[matchIdx] ?? -1 } : undefined}
          onMeta={onInputMeta}
        />
        <div className="mt-2 pt-2 border-t border-citrus-border/40 text-[10px] font-mono text-citrus-muted dark:text-citrus-night-muted dark:border-citrus-night-border/40">
          {metaText(inputMeta)}
        </div>
        {loading && (
          <div className="absolute inset-0 z-20 flex items-center justify-center rounded-xl bg-citrus-cream/85 dark:bg-citrus-night/85">
            <div className="flex items-center gap-2 text-sm font-semibold text-citrus-dark dark:text-citrus-night-text">
              <Loader2 className="w-4 h-4 animate-spin text-citrus-pink" /> {loading}
            </div>
          </div>
        )}
      </div>

      {/* OUTPUT */}
      <div className={cardClass}>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-citrus-pink animate-pulse" />
            <h4 className="text-xs font-bold uppercase tracking-wider text-citrus-dark dark:text-citrus-night-text">Output</h4>
          </div>
          <div className="flex items-center gap-1">
            <button className={wrap ? pillActive : pill} onClick={() => setWrap((w) => !w)} title="Toggle word wrap">
              Wrap
            </button>
            <button
              className={pill}
              onClick={() => onInput(out)}
              disabled={out === ''}
              title="Replace the input with this output"
            >
              <span className="inline-flex items-center gap-1"><ArrowLeft className="w-3 h-3" /> Use as Input</span>
            </button>
            <button className={pill} onClick={saveFile}>
              <span className="inline-flex items-center gap-1"><Download className="w-3 h-3" /> Save…</span>
            </button>
            {onSendToEnrichment && (
              <button
                className={pill}
                onClick={() => onSendToEnrichment(out === '' ? [] : [out])}
                disabled={out === ''}
                title="Send the output's IPs / domains / hashes to Global Intel"
              >
                <span className="inline-flex items-center gap-1"><Radar className="w-3 h-3" /> Send to Global Intel</span>
              </button>
            )}
            <button
              className="px-2.5 py-1 rounded-md text-[11px] font-bold bg-citrus-pink text-white hover:bg-citrus-pink-hover transition-colors inline-flex items-center gap-1"
              onClick={copyOutput}
            >
              <Copy className="w-3 h-3" /> {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
        </div>
        {result.error && (
          <div className="mb-2 text-[11px] font-medium text-citrus-pink-hover">{result.error}</div>
        )}
        <CodeArea
          ref={outputRef}
          className="pane__text pane__text--out"
          value={out}
          wrap={wrap}
          readOnly
          placeholder="Output appears here."
          highlight={find?.target === 'output' ? { term: findTerm, active: matches[matchIdx] ?? -1 } : undefined}
          onMeta={onOutputMeta}
        />
        {/* status bar: cursor/size metrics + slim IOC counts */}
        <div className="mt-2 pt-2 border-t border-citrus-border/40 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] font-mono dark:border-citrus-night-border/40">
          <span className="text-citrus-muted dark:text-citrus-night-muted">{metaText(outputMeta)}</span>
          <span className="text-citrus-border dark:text-citrus-night-border">|</span>
          {im ? (
            <>
              <IocStat label="IPs" n={im.ipv4} tone="text-red-600 dark:text-red-400" />
              <IocStat label="Domains" n={im.domains} tone="text-blue-600 dark:text-blue-400" />
              <IocStat label="URLs" n={im.urls} tone="text-indigo-600 dark:text-indigo-400" />
              <IocStat label="Hashes" n={im.hashes} tone="text-amber-600 dark:text-amber-400" />
            </>
          ) : (
            <>
              <span className="text-citrus-muted dark:text-citrus-night-muted">IOC counts skipped for large output</span>
              <button
                className="px-1.5 py-0.5 rounded text-citrus-pink hover:bg-citrus-pink-light font-bold dark:hover:bg-citrus-night-elev"
                onClick={() => setManualIoc(iocMetrics(out))}
              >
                Compute
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
