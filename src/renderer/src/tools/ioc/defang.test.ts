import { describe, expect, it } from 'vitest'
import { getById } from '../registry'
import './defang'

const defang = (s: string): string => getById('ioc.defang')!.run(s)
const refang = (s: string): string => getById('ioc.refang')!.run(s)

describe('defang / refang tools', () => {
  it('defangs scheme and dots', () => {
    expect(defang('http://192.0.2.44/payload')).toBe('hxxp://192[.]0[.]2[.]44/payload')
    expect(defang('https://host9.example')).toBe('hxxps://host9[.]example')
  })

  it('refangs back to live form', () => {
    expect(refang('hxxp://198[.]51[.]100[.]22')).toBe('http://198.51.100.22')
  })

  it('round-trips a URL', () => {
    const url = 'https://node4.example.com/a.b'
    expect(refang(defang(url))).toBe(url)
  })
})
