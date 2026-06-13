import { register } from '../registry'
import { defang, refang } from './patterns'

// Two complementary tools sharing the helpers in patterns.ts: defang to make
// indicators safe to paste, refang to turn them back for searching.

register({
  id: 'ioc.defang',
  name: 'Defang',
  category: 'ioc',
  description: 'Neutralize indicators for safe sharing (http→hxxp, . → [.]).',
  run: (input) => defang(input)
})

register({
  id: 'ioc.refang',
  name: 'Refang',
  category: 'ioc',
  description: 'Restore defanged indicators to live form (hxxp→http, [.] → .).',
  run: (input) => refang(input)
})
