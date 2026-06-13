import { useState } from 'react'
import type { WorkflowResult } from '../state/workflow'

function countLines(s: string): number {
  return s === '' ? 0 : s.split(/\r?\n/).length
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
  const textClass = `pane__text${wrap ? ' pane__text--wrap' : ''}`

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

  return (
    <div className="workbench">
      <div className="pane">
        <div className="pane__head">
          <span className="pane__title">Input</span>
          <span className="pane__meta">
            {countLines(input)} lines · {input.length} chars
          </span>
          <div className="pane__actions">
            <button
              className={`btn btn--ghost${wrap ? ' btn--active' : ''}`}
              onClick={() => setWrap((w) => !w)}
              title="Toggle word wrap"
            >
              Wrap
            </button>
            <button className="btn btn--ghost" onClick={loadFile}>
              Open…
            </button>
            <button className="btn btn--ghost" onClick={() => onInput('')}>
              Clear
            </button>
          </div>
        </div>
        <textarea
          className={textClass}
          wrap={wrap ? 'soft' : 'off'}
          value={input}
          spellCheck={false}
          placeholder="Paste data here…"
          onChange={(e) => onInput(e.target.value)}
        />
      </div>

      <div className="pane">
        <div className="pane__head">
          <span className="pane__title">Output</span>
          <span className="pane__meta">
            {countLines(result.output)} lines · {result.output.length} chars
          </span>
          <div className="pane__actions">
            <button
              className={`btn btn--ghost${wrap ? ' btn--active' : ''}`}
              onClick={() => setWrap((w) => !w)}
              title="Toggle word wrap"
            >
              Wrap
            </button>
            <button
              className="btn btn--ghost"
              onClick={() => onInput(result.output)}
              disabled={result.output === ''}
              title="Replace the input with this output"
            >
              Use as Input
            </button>
            <button className="btn btn--ghost" onClick={saveFile}>
              Save…
            </button>
            <button className="btn btn--ghost" onClick={copyOutput}>
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
        </div>
        {result.error && <div className="pane__error">{result.error}</div>}
        <textarea
          className={`${textClass} pane__text--out`}
          wrap={wrap ? 'soft' : 'off'}
          value={result.output}
          readOnly
          spellCheck={false}
          placeholder="Output appears here."
        />
      </div>
    </div>
  )
}
