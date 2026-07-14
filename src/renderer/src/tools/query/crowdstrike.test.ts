import { describe, expect, it } from 'vitest'
import { getById } from '../registry'
import './crowdstrike'

const run = (input: string, opts = {}): string =>
  getById('query.crowdstrike.cql')!.run(input, opts)

describe('CrowdStrike CQL builder', () => {
  it('renders an in() clause with the field= form', () => {
    expect(run('192.0.2.10\n192.0.2.20', { field: 'source.ip' })).toBe(
      'in(field=source.ip, values=["192.0.2.10", "192.0.2.20"])'
    )
  })

  it('trims, drops blanks, and dedups preserving order', () => {
    expect(run('  a  \n\nb\na\n', { field: 'f' })).toBe('in(field=f, values=["a", "b"])')
  })

  it('falls back to <field> when the field is blank', () => {
    expect(run('a', { field: '   ' })).toBe('in(field=<field>, values=["a"])')
  })

  it('wraps values per wildcard mode', () => {
    expect(run('sample.example', { field: 'd', wildcard: 'contains' })).toBe(
      'in(field=d, values=["*sample.example*"])'
    )
    expect(run('sample.example', { field: 'd', wildcard: 'prefix' })).toBe(
      'in(field=d, values=["*sample.example"])'
    )
    expect(run('sample.example', { field: 'd', wildcard: 'suffix' })).toBe(
      'in(field=d, values=["sample.example*"])'
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
