import { register } from '../registry'
import type { ToolOption, ToolOptions } from '../types'
import { IPV4, DOMAIN, URL, EMAIL, MD5, SHA1, SHA256, isPrivateIPv4, refang } from './patterns'

/**
 * Register an extractor: refang (optional) -> match a pattern -> optional filter
 * -> optional unique -> newline-joined. Output is just the indicators (one per
 * line) so it chains cleanly into dedup / SIEM tools.
 */
function makeExtractor(
  id: string,
  name: string,
  description: string,
  pattern: RegExp,
  extraOptions: ToolOption[] = [],
  filter?: (match: string, opts: ToolOptions) => boolean
): void {
  register({
    id,
    name,
    category: 'ioc',
    description,
    options: [
      { key: 'refang', label: 'Refang defanged IOCs first', type: 'boolean', default: true },
      { key: 'unique', label: 'Unique only', type: 'boolean', default: true },
      ...extraOptions
    ],
    run: (input, opts = {}) => {
      const text = opts.refang !== false ? refang(input) : input
      const re = new RegExp(pattern.source, pattern.flags)
      let matches: string[] = text.match(re) ?? []
      if (filter) matches = matches.filter((m) => filter(m, opts))
      if (opts.unique !== false) matches = [...new Set(matches)]
      return matches.join('\n')
    }
  })
}

makeExtractor(
  'ioc.extract.ipv4',
  'Extract IPv4',
  'Find IPv4 addresses (private/internal ranges excluded by default).',
  IPV4,
  [{ key: 'includePrivate', label: 'Include private/internal IPs', type: 'boolean', default: false }],
  (m, opts) => (opts.includePrivate ? true : !isPrivateIPv4(m))
)

makeExtractor('ioc.extract.domain', 'Extract Domains', 'Find domain names.', DOMAIN)
makeExtractor('ioc.extract.url', 'Extract URLs', 'Find http(s)/ftp URLs.', URL)
makeExtractor('ioc.extract.email', 'Extract Emails', 'Find email addresses.', EMAIL)
makeExtractor('ioc.extract.md5', 'Extract MD5', 'Find MD5 hashes (32 hex chars).', MD5)
makeExtractor('ioc.extract.sha1', 'Extract SHA1', 'Find SHA1 hashes (40 hex chars).', SHA1)
makeExtractor('ioc.extract.sha256', 'Extract SHA256', 'Find SHA256 hashes (64 hex chars).', SHA256)
