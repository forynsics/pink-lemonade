import { register } from '../registry'

// Browser- and Node-safe UTF-8 <-> Base64 (no Node Buffer; the renderer is
// sandboxed with no Node globals).
function toBase64(input: string): string {
  const bytes = new TextEncoder().encode(input)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

function fromBase64(input: string): string {
  const binary = atob(input)
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

register({
  id: 'text.base64.encode',
  name: 'Base64 Encode',
  category: 'text',
  description: 'Encode text to Base64 (UTF-8).',
  run: (input) => toBase64(input)
})

register({
  id: 'text.base64.decode',
  name: 'Base64 Decode',
  category: 'text',
  description: 'Decode Base64 to text (UTF-8).',
  run: (input) => {
    const cleaned = input.trim().replace(/\s+/g, '')
    if (cleaned === '') return ''
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) {
      throw new Error('Input is not valid Base64.')
    }
    return fromBase64(cleaned)
  }
})
