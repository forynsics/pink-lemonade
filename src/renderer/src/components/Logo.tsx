// Generated brand mark: a lemon slice on a pink→amber tile (the "pink lemonade").
export function Logo({ size = 26 }: { size?: number }): JSX.Element {
  const r = 8.5
  const segments = Array.from({ length: 8 }, (_, i) => {
    const a = (Math.PI / 4) * i + Math.PI / 8
    return { x: 16 + Math.cos(a) * (r - 0.6), y: 16 + Math.sin(a) * (r - 0.6) }
  })
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="pl-grad" x1="0" y1="0" x2="32" y2="32">
          <stop offset="0" stopColor="#e79bb1" />
          <stop offset="1" stopColor="#e7c46a" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#pl-grad)" />
      <circle cx="16" cy="16" r={r} fill="#fffdf7" />
      <circle cx="16" cy="16" r={r} fill="none" stroke="#e7c46a" strokeWidth="1.3" />
      <g stroke="#e8b84e" strokeWidth="1" strokeLinecap="round">
        {segments.map((p, i) => (
          <line key={i} x1="16" y1="16" x2={p.x} y2={p.y} />
        ))}
      </g>
      <circle cx="16" cy="16" r="1.5" fill="#e7c46a" />
    </svg>
  )
}
