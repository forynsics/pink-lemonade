// Single source of truth for IOC regexes so extractors, and later the SIEM
// builder and defang tools, all agree on what an indicator looks like.
// All patterns are global; callers should clone before stateful use.

export const IPV4 =
  /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g

export const SHA256 = /\b[a-fA-F0-9]{64}\b/g
export const SHA1 = /\b[a-fA-F0-9]{40}\b/g
export const MD5 = /\b[a-fA-F0-9]{32}\b/g

export const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g

export const URL = /\b(?:https?|ftp):\/\/[^\s<>"'`\])}]+/gi

// Domain labels + TLD. Intentionally broad; will also match the host part of
// URLs/emails. Good enough for a "pull every domain out of this blob" extractor.
export const DOMAIN =
  /\b(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}\b/g

export function isPrivateIPv4(ip: string): boolean {
  const o = ip.split('.').map(Number)
  if (o.length !== 4 || o.some((n) => Number.isNaN(n))) return false
  if (o[0] === 10) return true // 10.0.0.0/8
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true // 172.16.0.0/12
  if (o[0] === 192 && o[1] === 168) return true // 192.168.0.0/16
  if (o[0] === 127) return true // loopback
  if (o[0] === 169 && o[1] === 254) return true // link-local
  return false
}

/**
 * Convert common defanged indicators back to their live form so extraction
 * catches them: hxxp -> http, 1[.]2[.]3[.]4 -> 1.2.3.4, name[at]host -> name@host.
 * Conservative on purpose — only bracketed/parenthesized markers, never bare words.
 */
export function refang(text: string): string {
  return text
    .replace(/\[\.\]|\(\.\)|\{\.\}/g, '.')
    .replace(/\[dot\]|\(dot\)/gi, '.')
    .replace(/\[:\]|\[colon\]/gi, ':')
    .replace(/\[@\]|\(at\)|\[at\]/gi, '@')
    .replace(/hxxps?/gi, (m) => (m.length === 5 ? 'https' : 'http'))
}
