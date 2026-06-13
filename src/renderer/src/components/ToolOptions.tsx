import { getById } from '../tools/registry'
import type { ToolOptions as Opts } from '../tools/types'

export function ToolOptions({
  toolId,
  options,
  onChange
}: {
  toolId: string
  options: Opts
  onChange: (o: Opts) => void
}): JSX.Element | null {
  const tool = getById(toolId)
  if (!tool?.options?.length) return null

  const set = (key: string, value: string | boolean): void => onChange({ ...options, [key]: value })

  const fieldClass =
    'text-[11px] rounded border px-1.5 py-0.5 bg-citrus-card border-citrus-border text-citrus-dark outline-none focus:border-citrus-pink transition-colors dark:bg-citrus-night dark:border-citrus-night-border dark:text-citrus-night-text'

  return (
    <div className="mt-2 pt-2 border-t border-citrus-border/50 flex flex-wrap gap-x-4 gap-y-1.5 dark:border-citrus-night-border/50">
      {tool.options.map((opt) => (
        <label key={opt.key} className="flex items-center gap-1.5 text-[11px] text-citrus-muted dark:text-citrus-night-muted">
          {opt.type === 'boolean' ? (
            <>
              <input
                type="checkbox"
                className="accent-citrus-pink w-3.5 h-3.5"
                checked={!!options[opt.key]}
                onChange={(e) => set(opt.key, e.target.checked)}
              />
              <span>{opt.label}</span>
            </>
          ) : opt.type === 'select' ? (
            <>
              <span>{opt.label}</span>
              <select
                className={fieldClass}
                value={String(options[opt.key] ?? '')}
                onChange={(e) => set(opt.key, e.target.value)}
              >
                {opt.choices?.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </>
          ) : (
            <>
              <span>{opt.label}</span>
              <input
                type="text"
                className={fieldClass}
                value={String(options[opt.key] ?? '')}
                onChange={(e) => set(opt.key, e.target.value)}
              />
            </>
          )}
        </label>
      ))}
    </div>
  )
}
