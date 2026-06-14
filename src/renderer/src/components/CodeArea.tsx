import { forwardRef, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

// A textarea with a greyed line-number gutter (non-selectable, not part of the text)
// and a live "words · chars" count in the bottom-right corner.
//
// Two rendering paths, chosen by file size:
//
//  • Pretty mode (small files): a hidden mirror renders each logical line at the exact
//    textarea width/font/padding so soft-wrap is reproduced, and we measure each line's
//    real height to keep the gutter aligned even when a long line wraps to several rows.
//
//  • Performance mode (large files — see PERF_BYTES/PERF_LINES): the mirror and the
//    per-line gutter are O(total lines), so they freeze on a 71MB file. Instead we force
//    soft-wrap OFF (fixed line height) and *virtualize* the gutter: only the line numbers
//    in the viewport are rendered, positioned by scrollTop. DOM stays O(visible lines),
//    independent of file size.

const LH = 20 // px, matches Tailwind leading-5
const PAD = 12 // px, matches p-3
const GAP = 6 // px gap between gutter and text
const OVERSCAN = 8 // extra rows rendered above/below the viewport in perf mode

// Above either threshold we switch to the virtualized (perf) path.
const PERF_BYTES = 2_000_000
const PERF_LINES = 50_000
// Above this, skip the word count (a full .split over the text is too slow). Chars are free.
const METRICS_MAX = 2_000_000

/** Count visual lines without allocating a giant array (1 + number of '\n'). */
function countLines(s: string): number {
  let n = 1
  let i = -1
  while ((i = s.indexOf('\n', i + 1)) !== -1) n++
  return n
}

function countWords(s: string): number {
  const t = s.trim()
  return t === '' ? 0 : t.split(/\s+/).length
}

interface CodeAreaProps {
  value: string
  onChange?: (v: string) => void
  wrap: boolean
  placeholder?: string
  className?: string
  readOnly?: boolean
  /** Highlight every occurrence of `term` (Ctrl+F find); `active` is the char offset of the
   *  currently-focused match, shown in a stronger colour. Skipped on very large files. */
  highlight?: { term: string; active: number }
  /** Report cursor/size metrics to the parent's status bar (line/col are 1-based). */
  onMeta?: (m: { lines: number; chars: number; words: number | null; line: number; col: number }) => void
}

export interface CodeAreaMeta {
  lines: number
  chars: number
  words: number | null
  line: number
  col: number
}

// forwardRef exposes the underlying <textarea> (for the Notepad's Ctrl+F find, which drives
// native selection/scroll) while CodeArea keeps using it internally for measuring.
export const CodeArea = forwardRef<HTMLTextAreaElement, CodeAreaProps>(function CodeArea(
  { value, onChange, wrap, placeholder, className = '', readOnly = false, highlight, onMeta },
  externalRef
): JSX.Element {
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const setTa = useCallback(
    (el: HTMLTextAreaElement | null) => {
      taRef.current = el
      if (typeof externalRef === 'function') externalRef(el)
      else if (externalRef) (externalRef as React.MutableRefObject<HTMLTextAreaElement | null>).current = el
    },
    [externalRef]
  )
  const gutterRef = useRef<HTMLDivElement>(null)
  const mirrorRef = useRef<HTMLDivElement>(null)
  const bandRef = useRef<HTMLDivElement>(null)
  const rafId = useRef(0)
  const [clientW, setClientW] = useState(0)
  const [viewportH, setViewportH] = useState(0)
  const [fontsReady, setFontsReady] = useState(false)
  const [heights, setHeights] = useState<number[]>([])
  const [scrollTop, setScrollTop] = useState(0)
  // Caret offset, for the current-line highlight (code-editor "active line"). Kept even when the
  // pane is blurred (switching apps) so the user doesn't lose their place.
  const [caret, setCaret] = useState(0)

  const lineCount = useMemo(() => countLines(value), [value])
  const perf = value.length > PERF_BYTES || lineCount > PERF_LINES

  // The logical line the caret is on (0-based), and its top/height in content coords. In pretty
  // mode a wrapped line's height is the measured sum of its visual rows; in perf mode it's one LH.
  const curLine = useMemo(() => {
    let n = 0
    const lim = Math.min(caret, value.length)
    for (let i = 0; i < lim; i++) if (value.charCodeAt(i) === 10) n++
    return n
  }, [caret, value])
  const lineMetrics = useMemo(() => {
    if (perf) return { top: PAD + curLine * LH, height: LH }
    let top = PAD
    for (let i = 0; i < curLine; i++) top += heights[i] ?? LH
    return { top, height: heights[curLine] ?? LH }
  }, [perf, curLine, heights])
  // Held in a ref so the scroll handler can re-place the band without being re-created.
  const bandTopRef = useRef(0)
  bandTopRef.current = lineMetrics.top

  // 1-based column = chars since the caret's line start.
  const col = useMemo(() => {
    const c = Math.min(caret, value.length)
    let start = 0
    for (let i = c - 1; i >= 0; i--) {
      if (value.charCodeAt(i) === 10) {
        start = i + 1
        break
      }
    }
    return c - start + 1
  }, [caret, value])

  // Soft-wrap is impossible to virtualize with a fixed line height, so perf mode forces
  // it off (horizontal scroll). Pass the *effective* wrap to the textarea so the gutter's
  // fixed-height assumption and the textarea always agree.
  const effectiveWrap = perf ? false : wrap
  const wrapClass = effectiveWrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'

  // Only split into per-line nodes in pretty mode — the split itself is O(n) on huge files.
  const prettyLines = useMemo(() => (perf ? null : value.split('\n')), [perf, value])

  // Find-highlight backdrop nodes: the full text with each match wrapped in <mark>. Skipped in
  // perf mode (huge files) — selection-scroll still works there, just without the colour overlay.
  const term = highlight?.term ?? ''
  const highlightNodes = useMemo(() => {
    if (perf || term === '') return null
    const hay = value
    const lower = hay.toLowerCase()
    const needle = term.toLowerCase()
    const nodes: (string | JSX.Element)[] = []
    let from = 0
    let i = lower.indexOf(needle)
    if (i === -1) return null
    let k = 0
    while (i !== -1) {
      if (i > from) nodes.push(hay.slice(from, i))
      const isActive = i === highlight?.active
      nodes.push(
        <mark
          key={k++}
          data-active={isActive || undefined}
          className={isActive ? 'bg-citrus-pink/60 text-transparent' : 'bg-citrus-yellow/60 text-transparent'}
        >
          {hay.slice(i, i + needle.length)}
        </mark>
      )
      from = i + needle.length
      i = lower.indexOf(needle, from)
    }
    // Trailing text (plus a newline so the backdrop's last line matches the textarea's height).
    nodes.push(hay.slice(from) + '\n')
    return nodes
  }, [perf, term, value, highlight?.active])

  const digits = String(lineCount).length
  const gutterW = Math.ceil(digits * 7.5) + 14
  const padLeft = gutterW + GAP

  const words = useMemo(
    () => (value.length > METRICS_MAX ? null : countWords(value)),
    [value]
  )

  // Report metrics to the parent's status bar (kept out of the textarea so text never overlaps it).
  useEffect(() => {
    onMeta?.({ lines: lineCount, chars: value.length, words, line: curLine + 1, col })
  }, [onMeta, lineCount, value, words, curLine, col])

  // Track the textarea's content box (width for the mirror, height for the perf window).
  useLayoutEffect(() => {
    const ta = taRef.current
    if (!ta) return
    const measure = (): void => {
      setClientW(ta.clientWidth)
      setViewportH(ta.clientHeight)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(ta)
    return () => ro.disconnect()
  }, [])

  // Re-measure once web fonts finish loading (they change wrapping) — pretty mode only.
  useLayoutEffect(() => {
    document.fonts?.ready?.then(() => setFontsReady(true))
  }, [])

  // Pretty mode: measure each mirror line's rendered height.
  useLayoutEffect(() => {
    if (perf) return
    const m = mirrorRef.current
    if (!m) return
    const hs: number[] = []
    for (let i = 0; i < m.children.length; i++) {
      hs.push((m.children[i] as HTMLElement).offsetHeight || LH)
    }
    setHeights(hs)
  }, [perf, value, wrap, clientW, fontsReady])

  // Keep the perf-window's scrollTop in sync after the value changes (new file, doc switch).
  useLayoutEffect(() => {
    const ta = taRef.current
    if (ta && perf) setScrollTop(ta.scrollTop)
  }, [perf, value])

  const syncCaret = useCallback(() => {
    const ta = taRef.current
    if (ta) setCaret(ta.selectionStart)
  }, [])

  const onScroll = useCallback(() => {
    const ta = taRef.current
    if (!ta) return
    const bd = backdropRef.current
    if (bd) {
      bd.scrollTop = ta.scrollTop
      bd.scrollLeft = ta.scrollLeft
    }
    if (bandRef.current) bandRef.current.style.transform = `translateY(${bandTopRef.current - ta.scrollTop}px)`
    if (perf) {
      // rAF-throttle: one state update per frame during fast scrolls.
      if (rafId.current) return
      rafId.current = requestAnimationFrame(() => {
        rafId.current = 0
        const cur = taRef.current
        if (cur) setScrollTop(cur.scrollTop)
      })
    } else {
      const g = gutterRef.current
      if (g) g.style.transform = `translateY(${-ta.scrollTop}px)`
    }
  }, [perf])

  // Pretty mode: re-apply the gutter offset after a height re-measure.
  useLayoutEffect(() => {
    if (perf) return
    const ta = taRef.current
    const g = gutterRef.current
    if (ta && g) g.style.transform = `translateY(${-ta.scrollTop}px)`
  }, [perf, value, heights])

  // Re-place the current-line band when the caret moves or line heights change (no scroll event).
  useLayoutEffect(() => {
    const ta = taRef.current
    const b = bandRef.current
    if (ta && b) b.style.transform = `translateY(${lineMetrics.top - ta.scrollTop}px)`
  }, [lineMetrics, value])

  // Scroll the active find match into view (Ctrl+F "next"). The backdrop lays matches out exactly
  // like the textarea, so we read the active <mark>'s measured position; in perf mode (no backdrop,
  // wrap forced off) we derive it from the line index. Only scrolls when it's outside the viewport.
  useLayoutEffect(() => {
    const ta = taRef.current
    if (!ta || !highlight || highlight.active < 0 || highlight.term === '') return
    // Move the caret to the match (selection shows greyed; the current-line band follows it) so
    // stepping feels like a text editor. We don't focus the textarea — the find box keeps focus.
    ta.setSelectionRange(highlight.active, highlight.active + highlight.term.length)
    setCaret(highlight.active)
    let cTop: number
    const mark = backdropRef.current?.querySelector('mark[data-active]') as HTMLElement | null
    if (mark) {
      cTop = mark.offsetTop
    } else {
      let line = 0
      for (let j = 0; j < highlight.active && j < value.length; j++) {
        if (value.charCodeAt(j) === 10) line++
      }
      cTop = PAD + line * LH
    }
    const viewTop = ta.scrollTop
    if (cTop < viewTop + PAD || cTop + LH > viewTop + ta.clientHeight - PAD) {
      ta.scrollTop = Math.max(0, cTop - ta.clientHeight / 2)
      const bd = backdropRef.current
      if (bd) {
        bd.scrollTop = ta.scrollTop
        bd.scrollLeft = ta.scrollLeft
      }
      if (perf) setScrollTop(ta.scrollTop) // keep the perf gutter window in sync
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlight?.active, highlight?.term, value, perf])

  // Perf-mode visible window [first, last] of 0-based line indices.
  const first = Math.max(0, Math.floor((scrollTop - PAD) / LH) - OVERSCAN)
  const visCount = Math.ceil(viewportH / LH) + OVERSCAN * 2
  const last = Math.min(lineCount - 1, first + visCount)

  return (
    <div className="relative flex-1 min-h-0 overflow-hidden rounded-lg border border-citrus-border bg-citrus-cream dark:border-citrus-night-border dark:bg-citrus-night">
      {/* hidden mirror — pretty mode only — used to measure per-line wrapped heights */}
      {!perf && (
        <div
          ref={mirrorRef}
          aria-hidden
          className={`invisible absolute left-0 top-0 font-mono text-xs leading-5 ${wrapClass}`}
          style={{
            width: clientW || '100%',
            boxSizing: 'border-box',
            paddingTop: PAD,
            paddingBottom: PAD,
            paddingLeft: padLeft,
            paddingRight: PAD
          }}
        >
          {prettyLines!.map((ln, i) => (
            <div key={i}>{ln === '' ? '​' : ln}</div>
          ))}
        </div>
      )}

      {/* line-number gutter (not selectable, not part of the text) */}
      {perf ? (
        <div
          aria-hidden
          className="absolute left-0 top-0 bottom-0 z-10 overflow-hidden select-none pointer-events-none font-mono text-xs leading-5 text-citrus-muted/55 bg-citrus-cream border-r border-citrus-border/60 dark:text-citrus-night-muted/55 dark:bg-citrus-night dark:border-citrus-night-border/60"
          style={{ width: gutterW }}
        >
          <div
            className="absolute top-0 text-right"
            style={{
              right: 6,
              transform: `translateY(${PAD + first * LH - scrollTop}px)`,
              willChange: 'transform'
            }}
          >
            {Array.from({ length: Math.max(0, last - first + 1) }, (_, k) => (
              <div key={first + k} style={{ height: LH }}>
                {first + k + 1}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div
          ref={gutterRef}
          aria-hidden
          className="absolute left-0 top-0 z-10 select-none pointer-events-none text-right font-mono text-xs leading-5 text-citrus-muted/55 bg-citrus-cream border-r border-citrus-border/60 dark:text-citrus-night-muted/55 dark:bg-citrus-night dark:border-citrus-night-border/60"
          style={{ width: gutterW, paddingTop: PAD, paddingRight: 6, willChange: 'transform' }}
        >
          {prettyLines!.map((_, i) => (
            <div key={i} style={{ height: heights[i] ?? LH }}>
              {i + 1}
            </div>
          ))}
        </div>
      )}

      {/* current-line band: a faint full-width strip behind the text, glued to the caret's
          logical line (covers all its wrapped rows) and translated with scroll. Stays visible
          when the pane is blurred so the user keeps their place when switching apps. */}
      <div
        ref={bandRef}
        aria-hidden
        className="absolute left-0 right-0 top-0 pointer-events-none bg-citrus-pink/[0.07] dark:bg-citrus-pink/[0.13]"
        style={{ height: lineMetrics.height }}
      />

      {/* find-highlight backdrop: same text/box as the textarea, behind it, scroll-synced.
          The textarea is transparent on top so its real glyphs show over the <mark> bands. */}
      {highlightNodes && (
        <div
          ref={backdropRef}
          aria-hidden
          className={`absolute left-0 top-0 bottom-0 overflow-hidden pointer-events-none font-mono text-xs leading-5 text-transparent ${wrapClass}`}
          style={{
            // Match the textarea's CONTENT width (clientWidth excludes the vertical scrollbar) so
            // wrapping lines up exactly; using full width would wrap later than the textarea does.
            width: clientW || '100%',
            boxSizing: 'border-box',
            paddingTop: PAD,
            paddingBottom: PAD,
            paddingRight: PAD,
            paddingLeft: padLeft
          }}
        >
          {highlightNodes}
        </div>
      )}

      <textarea
        ref={setTa}
        className={`absolute inset-0 h-full w-full resize-none bg-transparent font-mono text-xs leading-5 text-citrus-dark outline-none dark:text-citrus-night-text ${wrapClass} ${
          effectiveWrap ? 'overflow-x-hidden' : 'overflow-x-auto'
        } ${className}`}
        style={{ paddingTop: PAD, paddingBottom: PAD, paddingRight: PAD, paddingLeft: padLeft }}
        value={value}
        readOnly={readOnly}
        spellCheck={false}
        placeholder={placeholder}
        onChange={
          onChange
            ? (e) => {
                onChange(e.target.value)
                setCaret(e.target.selectionStart)
              }
            : undefined
        }
        onScroll={onScroll}
        onSelect={syncCaret}
        onKeyUp={syncCaret}
        onClick={syncCaret}
        onFocus={syncCaret}
        wrap={effectiveWrap ? 'soft' : 'off'}
      />

    </div>
  )
})
