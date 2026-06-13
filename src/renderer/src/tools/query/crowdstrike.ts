import { register } from '../registry'

// Object -> query builder. Takes a list of objects (IPs, domains, hashes — one
// per line) and renders a CrowdStrike CQL `in()` clause for a chosen field.
// First (and currently only) platform; Sentinel/Splunk would be sibling tools.
//
// CQL reference (Falcon LogScale / Next-Gen SIEM), verified against the docs:
//   in(field=source.ip, values=["1.2.3.4", "5.6.7.8"])
//   in(field=loglevel, ignoreCase=true, values=["error", "warn"])
//   !in(field=source.ip, values=["1.2.3.4"])
// Wildcards live inside the quoted values: values=["*evil.com*"].

type WildcardMode = 'none' | 'contains' | 'prefix' | 'suffix'

function wrapWildcard(value: string, mode: WildcardMode): string {
  switch (mode) {
    case 'contains':
      return `*${value}*`
    case 'prefix':
      return `*${value}`
    case 'suffix':
      return `${value}*`
    default:
      return value
  }
}

register({
  id: 'query.crowdstrike.cql',
  name: 'CrowdStrike CQL',
  category: 'query',
  description: 'Build a CrowdStrike CQL in() clause from a list of objects.',
  options: [
    { key: 'field', label: 'Field name', type: 'string', default: 'source.ip' },
    {
      key: 'wildcard',
      label: 'Wildcard',
      type: 'select',
      default: 'none',
      choices: ['none', 'contains', 'prefix', 'suffix']
    },
    { key: 'ignoreCase', label: 'Case-insensitive', type: 'boolean', default: false },
    { key: 'negate', label: 'Negate (!in)', type: 'boolean', default: false }
  ],
  run: (input, opts = {}) => {
    const field = (typeof opts.field === 'string' ? opts.field.trim() : '') || '<field>'
    const wildcard = (opts.wildcard as WildcardMode) || 'none'
    const ignoreCase = !!opts.ignoreCase
    const negate = !!opts.negate

    // One object per line; trim, drop blanks, dedup preserving order.
    const seen = new Set<string>()
    const values: string[] = []
    for (const raw of input.split(/\r?\n/)) {
      const v = raw.trim()
      if (!v || seen.has(v)) continue
      seen.add(v)
      values.push(v)
    }
    if (values.length === 0) return ''

    const quoted = values
      .map((v) => `"${wrapWildcard(v, wildcard).replace(/"/g, '\\"')}"`)
      .join(', ')

    const caseArg = ignoreCase ? ', ignoreCase=true' : ''
    return `${negate ? '!' : ''}in(field=${field}${caseArg}, values=[${quoted}])`
  }
})
