import { register } from '../registry'

register({
  id: 'text.whitespace',
  name: 'Clean Whitespace',
  category: 'text',
  description: 'Trim lines, drop blank lines, and/or collapse internal whitespace.',
  options: [
    { key: 'trim', label: 'Trim each line', type: 'boolean', default: true },
    { key: 'stripBlank', label: 'Remove blank lines', type: 'boolean', default: true },
    { key: 'collapse', label: 'Collapse internal whitespace', type: 'boolean', default: false }
  ],
  run: (input, opts = {}) => {
    const trim = opts.trim !== false
    const stripBlank = opts.stripBlank !== false
    const collapse = !!opts.collapse

    let lines = input.split(/\r?\n/).map((line) => {
      let s = line
      if (collapse) s = s.replace(/[ \t]+/g, ' ')
      if (trim) s = s.trim()
      return s
    })
    if (stripBlank) lines = lines.filter((l) => l.trim() !== '')
    return lines.join('\n')
  }
})
