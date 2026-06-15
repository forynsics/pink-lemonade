import { describe, expect, it } from 'vitest'
import { buildDownloadUrl, DEFAULT_EDITIONS } from './maxmindSetup'

describe('maxmindSetup.buildDownloadUrl', () => {
  it('builds the geoip_download URL with edition, key, and tar.gz suffix', () => {
    const url = buildDownloadUrl('GeoLite2-City', 'KEY123')
    expect(url).toContain('https://download.maxmind.com/app/geoip_download?')
    expect(url).toContain('edition_id=GeoLite2-City')
    expect(url).toContain('license_key=KEY123')
    expect(url).toContain('suffix=tar.gz')
  })

  it('url-encodes the license key', () => {
    expect(buildDownloadUrl('GeoLite2-ASN', 'a/b+c=')).toContain('license_key=a%2Fb%2Bc%3D')
  })

  it('defaults to installing City + ASN', () => {
    expect(DEFAULT_EDITIONS).toEqual(['GeoLite2-City', 'GeoLite2-ASN'])
  })
})
