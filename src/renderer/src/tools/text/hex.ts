import { register } from '../registry'

register({
  id: 'text.hex.encode',
  name: 'Hex Encode',
  category: 'text',
  description: 'Encode text to hexadecimal (UTF-8).',
  options: [
    {
      key: 'delimiter',
      label: 'Byte delimiter',
      type: 'select',
      choices: ['none', 'space', 'colon'],
      default: 'none'
    }
  ],
  run: (input, opts = {}) => {
    const bytes = new TextEncoder().encode(input)
    const sep = opts.delimiter === 'space' ? ' ' : opts.delimiter === 'colon' ? ':' : ''
    return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(sep)
  }
})

register({
  id: 'text.hex.decode',
  name: 'Hex Decode',
  category: 'text',
  description: 'Decode hex to text (UTF-8). Ignores spaces, colons, and 0x prefixes.',
  run: (input) => {
    const clean = input.replace(/0x/gi, '').replace(/[^0-9a-fA-F]/g, '')
    if (clean.length % 2 !== 0) {
      throw new Error('Hex input has an odd number of digits.')
    }
    const bytes = new Uint8Array(clean.length / 2)
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
    }
    return new TextDecoder().decode(bytes)
  }
})
