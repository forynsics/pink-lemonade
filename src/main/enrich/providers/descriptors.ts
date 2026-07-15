// What each provider needs configured, as plain data.
//
// Dependency-free ON PURPOSE. Main imports this to drive key storage and the per-run secret
// injection, and main must never import providers/index.ts — that reaches maxmind.ts -> csv/db.ts ->
// better-sqlite3, which is worker-only. Keep this module free of any import that isn't a type.
//
// Adding a keyed provider = one entry here + the provider module + one line in providers/index.ts.
// Nothing in the settings dialog, the storage layer, or the injection path needs to learn about it.

export interface ProviderKeySpec {
  /** Field label in the settings dialog. */
  label: string
  /** One line of help under the field. */
  help: string
  /** Where the user gets a key. */
  signupUrl?: string
  /** settings.json field holding the safeStorage-encrypted key. Named explicitly rather than derived
   *  from the id so the two shipped providers keep the fields they already wrote — nobody has to
   *  re-enter a key. New providers should just use `${id}KeyEnc`. */
  field: string
  /** True when the key is handed to lookup() on every run (VirusTotal). False when it is only used
   *  during setup — MaxMind's license key downloads the .mmdb and is never used at lookup time. */
  usedAtLookup: boolean
  /** Non-secret fields written alongside the key (e.g. a detected tier's pacing), cleared with it. */
  extraFields?: string[]
  /** settings.json field holding the requests-per-minute to pace this provider at, when its tier is
   *  detected at save time. Omitted = use the rate the provider module declares. */
  paceField?: string
}

export interface ProviderConfigSpec {
  key?: ProviderKeySpec
}

export const PROVIDER_CONFIG: Record<string, ProviderConfigSpec> = {
  maxmind: {
    key: {
      label: 'License key',
      help: 'Only used to download the GeoLite2 database. Lookups run against the local file — no network.',
      signupUrl: 'https://www.maxmind.com/en/geolite2/signup',
      field: 'maxmindKeyEnc',
      usedAtLookup: false
    }
  },
  virustotal: {
    key: {
      label: 'API key',
      help: 'Verified when you save it; your plan sets the lookup pace.',
      signupUrl: 'https://www.virustotal.com/gui/my-apikey',
      field: 'vtKeyEnc',
      usedAtLookup: true,
      extraFields: ['vtRequestsPerMinute', 'vtDailyQuota'],
      paceField: 'vtRequestsPerMinute'
    }
  }
}

/** The key spec for a provider, or undefined when it needs no key (e.g. watchlist). */
export function keySpec(providerId: string): ProviderKeySpec | undefined {
  return PROVIDER_CONFIG[providerId]?.key
}

/** True when this provider's key must be decrypted and injected into lookup() for a run. */
export function needsKeyAtLookup(providerId: string): boolean {
  return keySpec(providerId)?.usedAtLookup === true
}
