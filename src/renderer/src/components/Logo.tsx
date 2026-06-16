import { useId } from 'react'

// Brand mark: a glass of pink lemonade — lemon wedge on the rim, straw, bubbles. The glass outline
// is `currentColor` (set here to the themed text token) so it's dark on light and light on dark; the
// liquid + lemon stay fixed brand colors. Pure inline SVG: transparent, crisp at any size, no asset
// fetch — consistent with the bundled/self-contained build. Used in the header, Welcome, and About.
export function Logo({ size = 26 }: { size?: number }): JSX.Element {
  // Unique ids per instance so multiple logos on screen don't share a gradient/clip (url(#…) would
  // otherwise resolve to the first one). useId() can contain ':', invalid in a url() ref — strip it.
  const uid = useId().replace(/:/g, '')
  const liq = `pl-liq-${uid}`
  const clip = `pl-clip-${uid}`
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      className="text-citrus-dark dark:text-citrus-night-text"
    >
      <defs>
        <linearGradient id={liq} x1="16" y1="12.5" x2="16" y2="25" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#f9bdd2" />
          <stop offset="1" stopColor="#ea84a8" />
        </linearGradient>
        <clipPath id={clip}>
          <path d="M10.3 8.2 L11.95 24.9 Q12.05 25.6 12.8 25.6 L19.2 25.6 Q19.95 25.6 20.05 24.9 L21.7 8.2 Z" />
        </clipPath>
      </defs>

      {/* liquid + straw + bubbles, clipped to the glass interior */}
      <g clipPath={`url(#${clip})`}>
        <rect x="9" y="12.6" width="14" height="14" fill={`url(#${liq})`} />
        <ellipse cx="16" cy="12.8" rx="5.6" ry="1.3" fill="#fcd2e1" />
        <circle cx="13.8" cy="18.5" r="0.7" fill="#fff" opacity="0.5" />
        <circle cx="17.2" cy="20.4" r="0.55" fill="#fff" opacity="0.45" />
        <circle cx="15.3" cy="22" r="0.45" fill="#fff" opacity="0.45" />
        <path d="M13.7 9 L16.6 21.5" stroke="#f3a6c2" strokeWidth="1.1" strokeLinecap="round" />
      </g>

      {/* glass surface highlight */}
      <path d="M12.2 11 L12.8 22" stroke="#ffffff" strokeWidth="1" strokeLinecap="round" opacity="0.5" />

      {/* glass outline — adapts to the theme via currentColor */}
      <g stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" fill="none">
        <path d="M9.7 8 L11.7 25.2 Q11.85 26.5 13.2 26.5 L18.8 26.5 Q20.15 26.5 20.3 25.2 L22.3 8" />
        <ellipse cx="16" cy="8" rx="6.3" ry="1.7" />
      </g>

      {/* lemon wedge on the rim */}
      <g strokeLinejoin="round">
        <path d="M17.9 11.2 L23.1 7.2 A3.3 3.3 0 0 1 21.4 13.0 Z" fill="#fff7e3" stroke="#dca63a" strokeWidth="0.7" />
        <path d="M18.7 11.0 L22.5 8.05 A2.4 2.4 0 0 1 21.2 12.3 Z" fill="#f5cd54" />
        <g stroke="#dca63a" strokeWidth="0.45" strokeLinecap="round">
          <line x1="19.9" y1="10.3" x2="21.0" y2="8.6" />
          <line x1="19.9" y1="10.3" x2="22.3" y2="9.7" />
          <line x1="19.9" y1="10.3" x2="20.7" y2="11.7" />
        </g>
      </g>
    </svg>
  )
}
