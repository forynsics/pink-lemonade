import { describe, expect, it } from 'vitest'
import { getById } from '../registry'
import './mde'

const run = (input: string, opts = {}): string =>
  getById('query.mde.kql')!.run(input, opts)

describe('Microsoft Defender KQL builder', () => {
  it('renders an in() where-clause by default', () => {
    expect(run('myurl1\nmyurl2', { field: 'RemoteUrl' })).toBe(
      '| where RemoteUrl in ("myurl1", "myurl2")'
    )
  })

  it('uses in~ when case-insensitive', () => {
    expect(run('a', { field: 'RemoteUrl', ignoreCase: true })).toBe(
      '| where RemoteUrl in~ ("a")'
    )
  })

  it('uses !in / !in~ when negated', () => {
    expect(run('a', { field: 'f', negate: true })).toBe('| where f !in ("a")')
    expect(run('a', { field: 'f', negate: true, ignoreCase: true })).toBe('| where f !in~ ("a")')
  })

  it('renders has_any term match', () => {
    expect(run('a\nb', { field: 'RemoteUrl', match: 'has_any' })).toBe(
      '| where RemoteUrl has_any ("a", "b")'
    )
  })

  it('wraps has_any negation in not() and ignores case toggle (already case-insensitive)', () => {
    expect(run('a', { field: 'RemoteUrl', match: 'has_any', negate: true })).toBe(
      '| where not(RemoteUrl has_any ("a"))'
    )
    expect(run('a', { field: 'RemoteUrl', match: 'has_any', ignoreCase: true })).toBe(
      '| where RemoteUrl has_any ("a")'
    )
  })

  it('trims, drops blanks, and dedups preserving order', () => {
    expect(run('  a  \n\nb\na\n', { field: 'f' })).toBe('| where f in ("a", "b")')
  })

  it('falls back to <field> when the field is blank', () => {
    expect(run('a', { field: '  ' })).toBe('| where <field> in ("a")')
  })

  it('returns empty string for empty input', () => {
    expect(run('  \n\n', { field: 'f' })).toBe('')
  })
})
