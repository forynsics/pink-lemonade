import { IPV4, DOMAIN, URL, MD5, SHA1, SHA256 } from '../tools/ioc/patterns'

/** Count non-overlapping matches of a global pattern, cloned to avoid lastIndex state. */
function count(text: string, pattern: RegExp): number {
  if (!text) return 0
  return (text.match(new RegExp(pattern.source, pattern.flags)) ?? []).length
}

export interface TextMetrics {
  lines: number
  words: number
  chars: number
}

export interface IocMetrics {
  ipv4: number
  domains: number
  urls: number
  hashes: number
}

/** Cheap text counters for the input pane. */
export function textMetrics(input: string): TextMetrics {
  return {
    lines: input === '' ? 0 : input.split(/\r?\n/).length,
    words: input.trim() === '' ? 0 : input.trim().split(/\s+/).length,
    chars: input.length
  }
}

/** Live IOC counters for the output pane — reuses the shared regexes in patterns.ts. */
export function iocMetrics(output: string): IocMetrics {
  return {
    ipv4: count(output, IPV4),
    domains: count(output, DOMAIN),
    urls: count(output, URL),
    hashes: count(output, MD5) + count(output, SHA1) + count(output, SHA256)
  }
}
