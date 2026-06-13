import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'

// A textarea with a greyed line-number gutter (non-selectable, not part of the text)
// and a live "words · chars" count in the bottom-right corner.
//
// The gutter stays aligned even with soft-wrap on: a hidden mirror renders each logical
// line as a block of the exact same width/font/padding as the textarea, so it wraps
// identically. We measure each mirror line's real height and give the matching gutter
// number that same height — correct even when a long word forces an early line break.

const LH = 20 // px, matches Tailwind leading-5
const PAD = 12 // px, matches p-3
const GAP = 6 // px gap between gutter and text

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
  const [clientW, setClientW] = useState(0)
  const [fontsReady, setFontsReady] = useState(false)
  const [heights, setHeights] = useState<number[]>([])

  const lines = useMemo(() => value.split('\n'), [value])
  const digits = String(lines.length).length
  const gutterW = Math.ceil(digits * 7.5) + 14
  const padLeft = gutterW + GAP

  // Track the textarea's content width (excludes its scrollbar) for the mirror.
  useLayoutEffect(() => {
    const ta = taRef.current
    if (!ta) return
    setClientW(ta.clientWidth)
    const ro = new ResizeObserver(() => setClientW(ta.clientWidth))
    ro.observe(ta)
    return () => ro.disconnect()
  }, [])

  // Re-measure once web fonts finish loading (they change wrapping).
  useLayoutEffect(() => {
    document.fonts?.ready?.then(() => setFontsReady(true))
  }, [])

  // Measure each mirror line's rendered height.
  useLayoutEffect(() => {
    const m = mirrorRef.current
    if (!m) return
    const hs: number[] = []
    for (let i = 0; i < m.children.length; i++) {
      hs.push((m.children[i] as HTMLElement).offsetHeight || LH)
    }
    setHeights(hs)
  }, [value, wrap, clientW, fontsReady])

  const syncScroll = useCallback(() => {
    const ta = taRef.current
    const g = gutterRef.current
    if (ta && g) g.style.transform = `translateY(${-ta.scrollTop}px)`
  }, [])

  useLayoutEffect(syncScroll, [value, heights, syncScroll])

  const wrapClass = wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'

  return (
    <div className="relative flex-1 min-h-0 overflow-hidden rounded-lg border border-citrus-border bg-citrus-cream dark:border-citrus-night-border dark:bg-citrus-night">
      {/* hidden mirror used only to measure per-line wrapped heights */}
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
        {lines.map((ln, i) => (
          <div key={i}>{ln === '' ? '​' : ln}</div>
        ))}
      </div>

      {/* line-number gutter (not selectable, not part of the text) */}
      <div
        ref={gutterRef}
        aria-hidden
        className="absolute left-0 top-0 select-none pointer-events-none text-right font-mono text-xs leading-5 text-citrus-muted/55 bg-citrus-cream border-r border-citrus-border/60 dark:text-citrus-night-muted/55 dark:bg-citrus-night dark:border-citrus-night-border/60"
        style={{ width: gutterW, paddingTop: PAD, paddingRight: 6, willChange: 'transform' }}
      >
        {lines.map((_, i) => (
          <div key={i} style={{ height: heights[i] ?? LH }}>
            {i + 1}
          </div>
        ))}
      </div>

      <textarea
        ref={taRef}
        className={`absolute inset-0 h-full w-full resize-none bg-transparent font-mono text-xs leading-5 text-citrus-dark outline-none dark:text-citrus-night-text ${wrapClass} ${
          wrap ? 'overflow-x-hidden' : 'overflow-x-auto'
        } ${className}`}
        style={{ paddingTop: PAD, paddingBottom: PAD, paddingRight: PAD, paddingLeft: padLeft }}
        value={value}
        readOnly={readOnly}
        spellCheck={false}
        placeholder={placeholder}
        onChange={onChange ? (e) => onChange(e.target.value) : undefined}
        onScroll={syncScroll}
        wrap={wrap ? 'soft' : 'off'}
      />

      {/* live word / character count */}
      <div className="absolute bottom-1.5 right-3 select-none pointer-events-none text-[10px] font-mono text-citrus-muted/70 dark:text-citrus-night-muted/70">
        {countWords(value)} words · {value.length} chars
      </div>
    </div>
  )
}
