import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'

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

export function CodeArea({
  value,
  onChange,
  wrap,
  placeholder,
  className = '',
  readOnly = false
}: {
  value: string
  onChange?: (v: string) => void
  wrap: boolean
  placeholder?: string
  className?: string
  readOnly?: boolean
}): JSX.Element {
  const taRef = useRef<HTMLTextAreaElement>(null)
  const gutterRef = useRef<HTMLDivElement>(null)
  const mirrorRef = useRef<HTMLDivElement>(null)
  const rafId = useRef(0)
  const [clientW, setClientW] = useState(0)
  const [viewportH, setViewportH] = useState(0)
  const [fontsReady, setFontsReady] = useState(false)
  const [heights, setHeights] = useState<number[]>([])
  const [scrollTop, setScrollTop] = useState(0)

  const lineCount = useMemo(() => countLines(value), [value])
  const perf = value.length > PERF_BYTES || lineCount > PERF_LINES

  // Soft-wrap is impossible to virtualize with a fixed line height, so perf mode forces
  // it off (horizontal scroll). Pass the *effective* wrap to the textarea so the gutter's
  // fixed-height assumption and the textarea always agree.
  const effectiveWrap = perf ? false : wrap
  const wrapClass = effectiveWrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'

  // Only split into per-line nodes in pretty mode — the split itself is O(n) on huge files.
  const prettyLines = useMemo(() => (perf ? null : value.split('\n')), [perf, value])

  const digits = String(lineCount).length
  const gutterW = Math.ceil(digits * 7.5) + 14
  const padLeft = gutterW + GAP

  const words = useMemo(
    () => (value.length > METRICS_MAX ? null : countWords(value)),
    [value]
  )

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

  const onScroll = useCallback(() => {
    const ta = taRef.current
    if (!ta) return
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

      <textarea
        ref={taRef}
        className={`absolute inset-0 h-full w-full resize-none bg-transparent font-mono text-xs leading-5 text-citrus-dark outline-none dark:text-citrus-night-text ${wrapClass} ${
          effectiveWrap ? 'overflow-x-hidden' : 'overflow-x-auto'
        } ${className}`}
        style={{ paddingTop: PAD, paddingBottom: PAD, paddingRight: PAD, paddingLeft: padLeft }}
        value={value}
        readOnly={readOnly}
        spellCheck={false}
        placeholder={placeholder}
        onChange={onChange ? (e) => onChange(e.target.value) : undefined}
        onScroll={onScroll}
        wrap={effectiveWrap ? 'soft' : 'off'}
      />

      {/* live word / character count */}
      <div className="absolute bottom-1.5 right-3 z-10 select-none pointer-events-none text-[10px] font-mono text-citrus-muted/70 dark:text-citrus-night-muted/70">
        {words === null ? '—' : words.toLocaleString()} words · {value.length.toLocaleString()} chars
      </div>
    </div>
  )
}
