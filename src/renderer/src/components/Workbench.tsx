import { useState } from 'react'
import { ArrowLeft, Copy, Download, FolderOpen } from 'lucide-react'
import type { WorkflowResult } from '../state/workflow'
import { textMetrics, iocMetrics } from '../state/metrics'

function Metric({ label, value, tone }: { label: string; value: number; tone?: string }): JSX.Element {
  return (
    <div className="rounded px-1 py-1 text-center bg-citrus-sand/30 dark:bg-citrus-night/40">
      <div className="text-[9px] uppercase font-bold tracking-wide text-citrus-muted dark:text-citrus-night-muted">
        {label}
      </div>
      <div className={`text-xs font-bold ${value > 0 && tone ? tone : 'text-citrus-dark dark:text-citrus-night-text'}`}>
        {value}
      </div>
    </div>
  )
}

export function Workbench({
  input,
  onInput,
  result
}: {
  input: string
  onInput: (v: string) => void
  result: WorkflowResult
}): JSX.Element {
  const [copied, setCopied] = useState(false)
  const [wrap, setWrap] = useState(true)

  const tm = textMetrics(input)
  const im = iocMetrics(result.output)

  const textClass = `flex-1 w-full p-3 rounded-lg text-xs font-mono leading-relaxed border border-citrus-border bg-citrus-cream/60 text-citrus-dark outline-none focus:border-citrus-pink resize-none transition-colors dark:bg-citrus-night dark:border-citrus-night-border dark:text-citrus-night-text ${
    wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre overflow-x-auto'
  }`

  const pill =
    'px-2.5 py-1 rounded-md text-[11px] font-bold text-citrus-muted hover:bg-citrus-sand/60 transition-colors dark:text-citrus-night-muted dark:hover:bg-citrus-night-elev'
  const pillActive = 'px-2.5 py-1 rounded-md text-[11px] font-bold bg-citrus-pink-light text-citrus-pink border border-citrus-pink/20'

  async function copyOutput(): Promise<void> {
    try {
      await navigator.clipboard.writeText(result.output)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      /* clipboard unavailable; ignore */
    }
  }

  async function loadFile(): Promise<void> {
    const file = await window.api?.openFile()
    if (file) onInput(file.content)
  }

  async function saveFile(): Promise<void> {
    await window.api?.saveFile(result.output)
  }

  const cardClass =
    'flex flex-col min-h-0 min-w-0 rounded-xl border border-citrus-border bg-citrus-card p-3 shadow-sm dark:border-citrus-night-border dark:bg-citrus-night-card'

  return (
    <div className="flex-1 grid grid-cols-2 gap-3 p-3 min-h-0 bg-citrus-cream/30 dark:bg-citrus-night">
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
        <textarea
          className={`pane__text ${textClass}`}
          wrap={wrap ? 'soft' : 'off'}
          value={input}
          spellCheck={false}
          placeholder="Paste data here…"
          onChange={(e) => onInput(e.target.value)}
        />
        <div className="mt-2.5 pt-2.5 border-t border-citrus-border/40 grid grid-cols-3 gap-2 dark:border-citrus-night-border/40">
          <Metric label="Lines" value={tm.lines} />
          <Metric label="Words" value={tm.words} />
          <Metric label="Chars" value={tm.chars} />
        </div>
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
              onClick={() => onInput(result.output)}
              disabled={result.output === ''}
              title="Replace the input with this output"
            >
              <span className="inline-flex items-center gap-1"><ArrowLeft className="w-3 h-3" /> Use as Input</span>
            </button>
            <button className={pill} onClick={saveFile}>
              <span className="inline-flex items-center gap-1"><Download className="w-3 h-3" /> Save…</span>
            </button>
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
        <textarea
          className={`pane__text pane__text--out ${textClass}`}
          wrap={wrap ? 'soft' : 'off'}
          value={result.output}
          readOnly
          spellCheck={false}
          placeholder="Output appears here."
        />
        <div className="mt-2.5 pt-2.5 border-t border-citrus-border/40 grid grid-cols-4 gap-2 dark:border-citrus-night-border/40">
          <Metric label="IPs" value={im.ipv4} tone="text-red-600 dark:text-red-400" />
          <Metric label="Domains" value={im.domains} tone="text-blue-600 dark:text-blue-400" />
          <Metric label="URLs" value={im.urls} tone="text-indigo-600 dark:text-indigo-400" />
          <Metric label="Hashes" value={im.hashes} tone="text-amber-600 dark:text-amber-400" />
        </div>
      </div>
    </div>
  )
}
