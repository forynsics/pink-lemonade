import { describe, expect, it } from 'vitest'
import { getById } from '../registry'
import './dedup'

const dedup = () => getById('text.dedup')!

describe('dedup', () => {
  it('removes duplicates keeping first-seen order', () => {
    expect(dedup().run('a\nb\na\nc\nb')).toBe('a\nb\nc')
  })

  it('is case-insensitive when enabled', () => {
    expect(dedup().run('Alpha\nalpha\nBeta', { caseInsensitive: true })).toBe('Alpha\nBeta')
  })

  it('sorts output when enabled', () => {
    expect(dedup().run('c\na\nb', { sort: true })).toBe('a\nb\nc')
  })

  it('trims by default so padded duplicates collapse', () => {
    expect(dedup().run('x\n  x  \ny')).toBe('x\ny')
  })
})
