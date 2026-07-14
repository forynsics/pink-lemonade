// Conversation history for the AI assistant. Two backends behind one async API, chosen by scope:
//   • a workspace is open  → the workspace DB (window.api.csv.wsConversation*), so chats travel with
//     the .workspace file alongside the investigation plan / events / IOCs.
//   • no workspace ("General", e.g. opened from Home or a notepad) → renderer localStorage.
// "New chat" archives the current conversation and starts a fresh one; nothing is destroyed unless
// the analyst explicitly deletes it.

export type Scope = string | null // workspace id, or null for the General (no-workspace) bucket

export interface ConvMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  turnCount: number
}
export interface Conversation extends ConvMeta {
  turns: unknown[]
}

const GENERAL_KEY = 'pink-lemonade:ai-chats'
const LEGACY_KEY = 'pink-lemonade:ai-chat' // the old single global transcript (pre-history)
const GENERAL_MAX = 40 // keep the most recent N General conversations
const GENERAL_MAX_BYTES = 2_000_000

export function newConversationId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `c_${Date.now()}_${Math.floor(Math.random() * 1e9).toString(36)}`
  }
}

/** A short title from the first user message (the conversation's subject), else a dated fallback. */
export function deriveTitle(turns: unknown[]): string {
  const first = (turns as Array<{ role?: string; content?: string }>).find((t) => t?.role === 'user' && t.content?.trim())
  const text = first?.content?.trim().replace(/\s+/g, ' ') ?? ''
  if (text) return text.length > 80 ? text.slice(0, 79) + '…' : text
  return 'Untitled chat'
}

// ---- General (localStorage) backend ----

function readGeneral(): Conversation[] {
  try {
    const raw = localStorage.getItem(GENERAL_KEY)
    if (raw) {
      const v = JSON.parse(raw)
      if (Array.isArray(v)) return v as Conversation[]
    }
  } catch {
    /* ignore */
  }
  return []
}

function writeGeneral(list: Conversation[]): void {
  try {
    let trimmed = list.slice(0, GENERAL_MAX)
    let json = JSON.stringify(trimmed)
    // Drop oldest conversations until under the byte cap (localStorage is shared + small).
    while (json.length > GENERAL_MAX_BYTES && trimmed.length > 1) {
      trimmed = trimmed.slice(0, -1)
      json = JSON.stringify(trimmed)
    }
    localStorage.setItem(GENERAL_KEY, json)
  } catch {
    /* quota or serialization failure — non-fatal */
  }
}

/** One-time migration: fold the old single global transcript into the General bucket as a chat. */
export function migrateLegacyChat(): void {
  try {
    const raw = localStorage.getItem(LEGACY_KEY)
    if (!raw) return
    const turns = JSON.parse(raw)
    localStorage.removeItem(LEGACY_KEY)
    if (Array.isArray(turns) && turns.length > 0) {
      const now = Date.now()
      const list = readGeneral()
      list.unshift({ id: newConversationId(), title: deriveTitle(turns), createdAt: now, updatedAt: now, turnCount: turns.length, turns })
      writeGeneral(list)
    }
  } catch {
    /* ignore */
  }
}

// ---- Unified API ----

export async function listConversations(scope: Scope): Promise<ConvMeta[]> {
  if (scope) return window.api.csv.wsConversationList(scope)
  return readGeneral()
    .map(({ turns: _turns, ...meta }) => meta)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function getConversation(scope: Scope, id: string): Promise<Conversation | null> {
  if (scope) return window.api.csv.wsConversationGet(scope, id)
  return readGeneral().find((c) => c.id === id) ?? null
}

export async function upsertConversation(scope: Scope, conv: { id: string; title?: string; turns: unknown[] }): Promise<void> {
  if (scope) {
    await window.api.csv.wsConversationUpsert(scope, conv)
    return
  }
  const now = Date.now()
  const list = readGeneral()
  const i = list.findIndex((c) => c.id === conv.id)
  const createdAt = i >= 0 ? list[i].createdAt : now
  const row: Conversation = { id: conv.id, title: conv.title ?? '', createdAt, updatedAt: now, turnCount: conv.turns.length, turns: conv.turns }
  if (i >= 0) list.splice(i, 1)
  list.unshift(row)
  writeGeneral(list)
}

export async function renameConversation(scope: Scope, id: string, title: string): Promise<void> {
  if (scope) {
    await window.api.csv.wsConversationRename(scope, id, title)
    return
  }
  const list = readGeneral()
  const c = list.find((x) => x.id === id)
  if (c) {
    c.title = title
    writeGeneral(list)
  }
}

export async function deleteConversation(scope: Scope, id: string): Promise<void> {
  if (scope) {
    await window.api.csv.wsConversationDelete(scope, id)
    return
  }
  writeGeneral(readGeneral().filter((c) => c.id !== id))
}
