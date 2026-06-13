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

  return (
    <div className="options">
      {tool.options.map((opt) => (
        <label key={opt.key} className="options__row">
          {opt.type === 'boolean' ? (
            <>
              <input
                type="checkbox"
                checked={!!options[opt.key]}
                onChange={(e) => set(opt.key, e.target.checked)}
              />
              <span>{opt.label}</span>
            </>
          ) : opt.type === 'select' ? (
            <>
              <span>{opt.label}</span>
              <select
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
