import { register } from '../registry'

register({
  id: 'text.dedup',
  name: 'Deduplicate Lines',
  category: 'text',
  description: 'Remove duplicate lines, keeping the first occurrence.',
  options: [
    { key: 'caseInsensitive', label: 'Case-insensitive', type: 'boolean', default: false },
    { key: 'trim', label: 'Trim lines before comparing', type: 'boolean', default: true },
    { key: 'sort', label: 'Sort output', type: 'boolean', default: false }
  ],
  run: (input, opts = {}) => {
    const caseInsensitive = !!opts.caseInsensitive
    const trim = opts.trim !== false
    const sort = !!opts.sort

    const seen = new Set<string>()
    const out: string[] = []
    for (const raw of input.split(/\r?\n/)) {
      const line = trim ? raw.trim() : raw
      const key = caseInsensitive ? line.toLowerCase() : line
      if (seen.has(key)) continue
      seen.add(key)
      out.push(line)
    }
    if (sort) out.sort((a, b) => a.localeCompare(b))
    return out.join('\n')
  }
})
