// The provider registry. Adding a provider (e.g. VirusTotal) = a new module + one line here.
import { maxmindProvider } from './maxmind'
import type { EnrichmentProvider } from './types'

export const PROVIDERS: EnrichmentProvider[] = [maxmindProvider]

export function getProvider(id: string): EnrichmentProvider | undefined {
  return PROVIDERS.find((p) => p.id === id)
}
