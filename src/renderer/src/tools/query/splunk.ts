import { register } from '../registry'

// Splunk (SPL) search-filter builder. Sibling to the CQL/KQL tools under the
// Query category: a list of objects (one per line) -> an SPL search predicate.
//
// SPL reference (Splunk search command docs), verified:
//   src_ip IN ("a", "b")          cleaner than: src_ip="a" OR src_ip="b"
//   src_ip IN ("4*")              wildcards allowed in the *search* command IN
//                                 (NOT in the eval/where IN function — so we emit
//                                 a bare predicate with no `| where`).
//   NOT src_ip IN (...)           negation.

type MatchMode = 'IN' | 'OR'
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
  id: 'query.splunk.spl',
  name: 'SPL',
  category: 'query',
  description: 'Build a Splunk (SPL) search filter from a list of objects.',
  options: [
    { key: 'field', label: 'Field name', type: 'string', default: 'src_ip' },
    { key: 'match', label: 'Match', type: 'select', default: 'IN', choices: ['IN', 'OR'] },
    {
      key: 'wildcard',
      label: 'Wildcard',
      type: 'select',
      default: 'none',
      choices: ['none', 'contains', 'prefix', 'suffix']
    },
    { key: 'negate', label: 'Negate', type: 'boolean', default: false }
  ],
  run: (input, opts = {}) => {
    const field = (typeof opts.field === 'string' ? opts.field.trim() : '') || '<field>'
    const match = (opts.match as MatchMode) || 'IN'
    const wildcard = (opts.wildcard as WildcardMode) || 'none'
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

    const quoted = values.map(
      (v) => `"${wrapWildcard(v, wildcard).replace(/"/g, '\\"')}"`
    )

    if (match === 'OR') {
      const chain = quoted.map((q) => `${field}=${q}`).join(' OR ')
      return negate ? `NOT (${chain})` : chain
    }

    return `${negate ? 'NOT ' : ''}${field} IN (${quoted.join(', ')})`
  }
})
