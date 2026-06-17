// The provider registry. Adding a provider (e.g. VirusTotal) = a new module + one line here.
import { maxmindProvider } from './maxmind'
import { watchlistProvider } from './watchlist'
import { virustotalProvider } from './virustotal'
import type { EnrichmentProvider } from './types'

export const PROVIDERS: EnrichmentProvider[] = [maxmindProvider, watchlistProvider, virustotalProvider]

export function getProvider(id: string): EnrichmentProvider | undefined {
  return PROVIDERS.find((p) => p.id === id)
}
