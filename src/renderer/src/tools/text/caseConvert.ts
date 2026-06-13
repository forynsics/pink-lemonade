import { register } from '../registry'

register({
  id: 'text.case',
  name: 'Change Case',
  category: 'text',
  description: 'Convert text to upper, lower, or title case.',
  options: [
    {
      key: 'mode',
      label: 'Case',
      type: 'select',
      choices: ['upper', 'lower', 'title'],
      default: 'upper'
    }
  ],
  run: (input, opts = {}) => {
    const mode = (opts.mode as string) || 'upper'
    if (mode === 'lower') return input.toLowerCase()
    if (mode === 'title') {
      return input.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    }
    return input.toUpperCase()
  }
})
