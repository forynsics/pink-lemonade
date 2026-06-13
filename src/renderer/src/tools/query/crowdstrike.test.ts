import { describe, expect, it } from 'vitest'
import { getById } from '../registry'
import './crowdstrike'

const run = (input: string, opts = {}): string =>
  getById('query.crowdstrike.cql')!.run(input, opts)

describe('CrowdStrike CQL builder', () => {
  it('renders an in() clause with the field= form', () => {
    expect(run('1.2.3.4\n5.6.7.8', { field: 'source.ip' })).toBe(
      'in(field=source.ip, values=["1.2.3.4", "5.6.7.8"])'
    )
  })

  it('trims, drops blanks, and dedups preserving order', () => {
    expect(run('  a  \n\nb\na\n', { field: 'f' })).toBe('in(field=f, values=["a", "b"])')
  })

  it('falls back to <field> when the field is blank', () => {
    expect(run('a', { field: '   ' })).toBe('in(field=<field>, values=["a"])')
  })

  it('wraps values per wildcard mode', () => {
    expect(run('evil.com', { field: 'd', wildcard: 'contains' })).toBe(
      'in(field=d, values=["*evil.com*"])'
    )
    expect(run('evil.com', { field: 'd', wildcard: 'prefix' })).toBe(
      'in(field=d, values=["*evil.com"])'
    )
    expect(run('evil.com', { field: 'd', wildcard: 'suffix' })).toBe(
      'in(field=d, values=["evil.com*"])'
    )
  })

  it('adds ignoreCase before values', () => {
    expect(run('a', { field: 'f', ignoreCase: true })).toBe(
      'in(field=f, ignoreCase=true, values=["a"])'
    )
  })

  it('prefixes ! when negated', () => {
    expect(run('a', { field: 'f', negate: true })).toBe('!in(field=f, values=["a"])')
  })

  it('returns empty string for empty input', () => {
    expect(run('   \n\n', { field: 'f' })).toBe('')
  })
})
