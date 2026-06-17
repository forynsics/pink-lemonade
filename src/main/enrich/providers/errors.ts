// Shared provider error types. Kept separate from types.ts (which is type-only) so both the engine
// and network providers can import the runtime class without a provider-specific dependency.

/** Thrown by a provider when the upstream API rate-limits the request (HTTP 429). The engine backs
 *  off (Retry-After if present, else 60s) and retries once; a daily-quota exhaustion (or a second
 *  429) is fatal and aborts the whole run instead of error-spamming every remaining row. */
export class RateLimitError extends Error {
  /** Seconds to wait before retrying, from the Retry-After header (if the API sent one). */
  readonly retryAfter?: number
  /** True when the limit is the daily quota (not the per-minute window) — retrying won't help. */
  readonly daily: boolean
  /** Set by the engine when a retry still rate-limits, so the caller treats it as fatal. */
  fatal?: boolean

  constructor(message: string, opts: { retryAfter?: number; daily?: boolean } = {}) {
    super(message)
    this.name = 'RateLimitError'
    this.retryAfter = opts.retryAfter
    this.daily = opts.daily ?? false
  }
}
