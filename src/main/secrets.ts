// Shared safeStorage helpers for API keys at rest. Encryption happens ONLY in main (safeStorage is
// main-only — the worker and renderer never see plaintext). Keys are stored base64-encoded under a
// namespaced blob in settings.json and decrypted just-in-time before a network call. Mirrors the
// originals in enrich/ipc.ts; extracted here so the AI surface reuses the same primitives.

import { safeStorage } from 'electron'

/** Encrypt a secret at rest (Electron safeStorage / OS keychain). null if unavailable. */
export function encryptKey(plain: string): string | null {
  if (!safeStorage.isEncryptionAvailable()) return null
  return safeStorage.encryptString(plain).toString('base64')
}

/** Decrypt a base64 safeStorage blob back to plaintext. null if it can't be decrypted. */
export function decryptKey(b64: string): string | null {
  try {
    return safeStorage.decryptString(Buffer.from(b64, 'base64'))
  } catch {
    return null
  }
}
