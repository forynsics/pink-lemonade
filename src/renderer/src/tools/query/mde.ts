import { register } from '../registry'

// Microsoft Defender for Endpoint / Advanced Hunting (KQL) query builder.
// Sibling to the CrowdStrike CQL tool: a list of objects (one per line) ->
// a `| where` clause matching a field against them.
//
// KQL reference (Microsoft Learn, string operators), verified:
//   RemoteUrl in ("a", "b")       exact full-value match, case-sensitive.
//   RemoteUrl in~ ("a", "b")      same, case-insensitive.
//   RemoteUrl has_any ("a", "b")  whole-term match, case-insensitive, index-accelerated.
//   not(RemoteUrl has_any (...))  negated has_any (KQL has no !has_any operator).

type MatchMode = 'in' | 'has_any'

register({
  id: 'query.mde.kql',
  name: 'Microsoft Defender KQL',
  category: 'query',
  description: 'Build a Defender Advanced Hunting (KQL) where-clause from a list of objects.',
  options: [
    { key: 'field', label: 'Field name', type: 'string', default: 'RemoteUrl' },
    { key: 'match', label: 'Match', type: 'select', default: 'in', choices: ['in', 'has_any'] },
    { key: 'ignoreCase', label: 'Case-insensitive', type: 'boolean', default: false },
    { key: 'negate', label: 'Negate', type: 'boolean', default: false }
  ],
  run: (input, opts = {}) => {
    const field = (typeof opts.field === 'string' ? opts.field.trim() : '') || '<field>'
    const match = (opts.match as MatchMode) || 'in'
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

    const list = values.map((v) => `"${v.replace(/"/g, '\\"')}"`).join(', ')

    let predicate: string
    if (match === 'has_any') {
      // has_any is already case-insensitive; KQL has no !has_any, so wrap with not().
      const expr = `${field} has_any (${list})`
      predicate = negate ? `not(${expr})` : expr
    } else {
      const op = `${negate ? '!' : ''}in${ignoreCase ? '~' : ''}`
      predicate = `${field} ${op} (${list})`
    }

    return `| where ${predicate}`
  }
})
