import { useCallback, useEffect, useState } from 'react'

// Width handling for the side panels (Constellation / Timeline / Investigation / IOC).
//
// Two problems this fixes, both reported as "it never renders the full display and I always have to
// resize it":
//
//  1. NO PERSISTENCE. Each panel re-opened at a hardcoded default every single time, so the resize
//     had to be repeated on every open — for every panel, every session. The workspace sidebar had
//     solved this years ago (`pink-lemonade:sidebar-w`); the AI panels never adopted it.
//  2. FIXED-PIXEL DEFAULTS. A 640px Timeline is most of a laptop screen and a third of a wide one, so
//     the first paint is either cramped or wasteful depending on the monitor. The default is now a
//     FRACTION of the window, clamped to the panel's own sensible bounds.
//
// The maximum is also viewport-relative: a hard 900px cap means a panel cannot use a wide monitor
// even when the analyst drags it. It still can't swallow the grid entirely — that's the floor of 45%.

export interface PanelWidthOpts {
  /** localStorage key — distinct per panel, so each remembers its own size. */
  key: string
  /** Narrowest useful width for this panel's content. */
  min: number
  /** Widest this panel should ever get, before the viewport cap applies. */
  max: number
  /** Share of the window to open at when there's no saved width. */
  defaultFraction: number
}

/** The panel may take at most this much of the window, so the grid it sits beside stays usable. */
const MAX_VIEWPORT_SHARE = 0.55

function viewportMax(max: number): number {
  const w = typeof window === 'undefined' ? 1280 : window.innerWidth
  // Never below the caller's min — on a very narrow window the min wins and the panel just overlaps.
  return Math.max(320, Math.min(max, Math.round(w * MAX_VIEWPORT_SHARE)))
}

/**
 * A drag-resizable, persisted panel width.
 *
 * Returns the current width, a setter that clamps and saves, and the clamp itself for drag handlers.
 * Clamping happens on READ as well as write: a width saved on a 4K monitor would otherwise reopen
 * off-screen on a laptop.
 */
export function usePanelWidth(opts: PanelWidthOpts): {
  width: number
  setWidth: (w: number) => void
  clamp: (w: number) => number
} {
  const clamp = useCallback(
    (w: number): number => Math.min(viewportMax(opts.max), Math.max(opts.min, Math.round(w))),
    [opts.min, opts.max]
  )

  const [width, setWidthState] = useState<number>(() => {
    try {
      const saved = Number(localStorage.getItem(opts.key))
      if (Number.isFinite(saved) && saved > 0) return clamp(saved)
    } catch {
      /* localStorage can throw in a locked-down profile; fall through to the default */
    }
    const w = typeof window === 'undefined' ? 1280 : window.innerWidth
    return clamp(w * opts.defaultFraction)
  })

  const setWidth = useCallback(
    (w: number): void => {
      const next = clamp(w)
      setWidthState(next)
      try {
        localStorage.setItem(opts.key, String(next))
      } catch {
        /* persistence is a convenience; never break resizing over it */
      }
    },
    [clamp, opts.key]
  )

  // Re-clamp when the window resizes: dragging the app to a smaller screen would otherwise leave a
  // panel wider than the window with no way back except a manual drag — the exact complaint.
  useEffect(() => {
    const onResize = (): void => setWidthState((w) => clamp(w))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [clamp])

  return { width, setWidth, clamp }
}
