import { describe, expect, it } from 'vitest'
import { getById } from '../registry'
import './splunk'

const run = (input: string, opts = {}): string =>
  getById('query.splunk.spl')!.run(input, opts)

describe('Splunk SPL builder', () => {
  it('renders an IN() filter by default', () => {
    expect(run('192.0.2.10\n192.0.2.20', { field: 'src_ip' })).toBe(
      'src_ip IN ("192.0.2.10", "192.0.2.20")'
    )
  })

  it('renders an OR chain in OR mode', () => {
    expect(run('192.0.2.10\n192.0.2.20', { field: 'src_ip', match: 'OR' })).toBe(
      'src_ip="192.0.2.10" OR src_ip="192.0.2.20"'
    )
  })

  it('negates IN with a leading NOT', () => {
    expect(run('a', { field: 'src_ip', negate: true })).toBe('NOT src_ip IN ("a")')
  })

  it('negates an OR chain by wrapping in NOT(...)', () => {
    expect(run('a\nb', { field: 'f', match: 'OR', negate: true })).toBe(
      'NOT (f="a" OR f="b")'
    )
  })

  it('applies wildcard wrapping to both modes', () => {
    expect(run('sample.example', { field: 'url', wildcard: 'contains' })).toBe(
      'url IN ("*sample.example*")'
    )
    expect(run('sample.example', { field: 'url', match: 'OR', wildcard: 'suffix' })).toBe(
      'url="sample.example*"'
    )
  })

  it('trims, drops blanks, and dedups preserving order', () => {
    expect(run('  a  \n\nb\na\n', { field: 'f' })).toBe('f IN ("a", "b")')
  })

  it('falls back to <field> when the field is blank', () => {
    expect(run('a', { field: '  ' })).toBe('<field> IN ("a")')
  })

  it('returns empty string for empty input', () => {
    expect(run('  \n\n', { field: 'f' })).toBe('')
  })
})
