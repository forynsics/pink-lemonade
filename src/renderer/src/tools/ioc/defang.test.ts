import { describe, expect, it } from 'vitest'
import { getById } from '../registry'
import './defang'

const defang = (s: string): string => getById('ioc.defang')!.run(s)
const refang = (s: string): string => getById('ioc.refang')!.run(s)

describe('defang / refang tools', () => {
  it('defangs scheme and dots', () => {
    expect(defang('http://1.2.3.4/payload')).toBe('hxxp://1[.]2[.]3[.]4/payload')
    expect(defang('https://evil.com')).toBe('hxxps://evil[.]com')
  })

  it('refangs back to live form', () => {
    expect(refang('hxxp://1[.]2[.]3[.]4')).toBe('http://1.2.3.4')
  })

  it('round-trips a URL', () => {
    const url = 'https://bad.example.com/a.b'
    expect(refang(defang(url))).toBe(url)
  })
})
