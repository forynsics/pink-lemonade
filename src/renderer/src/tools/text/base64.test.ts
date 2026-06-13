import { describe, expect, it } from 'vitest'
import { getById } from '../registry'
import './base64'

const enc = () => getById('text.base64.encode')!
const dec = () => getById('text.base64.decode')!

describe('base64', () => {
  it('round-trips UTF-8 text including multi-byte chars', () => {
    const s = 'héllo wörld 🍋'
    expect(dec().run(enc().run(s))).toBe(s)
  })

  it('decodes a known value', () => {
    expect(dec().run('aGVsbG8=')).toBe('hello')
  })

  it('tolerates whitespace/newlines in input', () => {
    expect(dec().run('aGVs\nbG8=')).toBe('hello')
  })

  it('throws on non-base64 input', () => {
    expect(() => dec().run('not base64!!')).toThrow()
  })
})
