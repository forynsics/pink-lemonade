import { register } from '../registry'

register({
  id: 'text.url.encode',
  name: 'URL Encode',
  category: 'text',
  description: 'Percent-encode a URI component.',
  run: (input) => encodeURIComponent(input)
})

register({
  id: 'text.url.decode',
  name: 'URL Decode',
  category: 'text',
  description: 'Decode a percent-encoded URI component (also turns "+" into spaces).',
  run: (input) => {
    try {
      return decodeURIComponent(input.replace(/\+/g, ' '))
    } catch {
      throw new Error('Input is not valid percent-encoding.')
    }
  }
})
