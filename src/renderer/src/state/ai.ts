// UI prefs for the AI assistant panel (open state + width). The authoritative provider/model/key
// config lives in main's settings.json (via window.api.ai); this only remembers the panel chrome.

const STORAGE_KEY = 'pink-lemonade:ai'

export interface AiPrefs {
  open: boolean
  width: number
}

const DEFAULT: AiPrefs = { open: false, width: 400 }

export function loadAiPrefs(): AiPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const p = JSON.parse(raw) as Partial<AiPrefs>
      return {
        open: typeof p.open === 'boolean' ? p.open : DEFAULT.open,
        width: typeof p.width === 'number' ? Math.min(720, Math.max(320, p.width)) : DEFAULT.width
      }
    }
  } catch {
    /* ignore */
  }
  return { ...DEFAULT }
}

export function saveAiPrefs(p: AiPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p))
  } catch {
    /* ignore */
  }
}

// Chat transcripts now live in state/aiChat.ts (per-workspace DB + General localStorage, with full
// conversation history). The old single global transcript key is migrated over by migrateLegacyChat.
