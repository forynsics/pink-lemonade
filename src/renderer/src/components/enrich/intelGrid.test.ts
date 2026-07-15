import { describe, expect, it } from 'vitest'
import { indicatorClass, verdictFieldOf } from './IntelGrid'

describe('indicatorClass', () => {
  it('groups the network indicators together', () => {
    for (const k of ['ipv4', 'ipv6', 'domain', 'url']) expect(indicatorClass(k)).toBe('Network')
  })

  it('groups every hash as File', () => {
    for (const k of ['md5', 'sha1', 'sha256']) expect(indicatorClass(k)).toBe('File')
  })

  it('keeps an IP and a hash in different sections', () => {
    expect(indicatorClass('ipv4')).not.toBe(indicatorClass('sha1'))
  })

  it('parks anything else in Other rather than forcing it into a section', () => {
    expect(indicatorClass('email')).toBe('Other')
    expect(indicatorClass('something-we-do-not-enrich-yet')).toBe('Other')
  })
})

describe('verdictFieldOf', () => {
  it('finds the field a provider grades with', () => {
    expect(verdictFieldOf(['VT Verdict', 'VT Malicious', 'VT Total'])).toBe('VT Verdict')
  })

  it('returns undefined for a provider that only reports facts', () => {
    // MaxMind geolocates; it never says good or bad, so it gets no Status column.
    expect(verdictFieldOf(['Country', 'Region', 'City', 'Lat/Lon', 'ASN'])).toBeUndefined()
  })

  it('returns undefined for a provider that reports membership', () => {
    // Watchlist is always status:'ok' — a Status column would say "ok" forever.
    expect(verdictFieldOf(['Lists'])).toBeUndefined()
  })

  it('matches on the name, so a new provider gets a verdict chip for free', () => {
    expect(verdictFieldOf(['AbuseIPDB Verdict'])).toBe('AbuseIPDB Verdict')
    expect(verdictFieldOf(['verdict'])).toBe('verdict')
  })

  it('does not match a field that merely mentions a verdict', () => {
    expect(verdictFieldOf(['Verdict History', 'Last Verdict Date'])).toBeUndefined()
  })

  it('survives an empty field list', () => {
    expect(verdictFieldOf([])).toBeUndefined()
  })
})
