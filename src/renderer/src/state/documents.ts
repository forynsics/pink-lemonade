import type { WorkflowStep } from './workflow'

/** One open document ("page") in the app — its own input and workflow. */
export interface PinkDoc {
  id: string
  name: string
  input: string
  steps: WorkflowStep[]
}

export interface DocsState {
  docs: PinkDoc[]
  activeId: string
}

const STORAGE_KEY = 'pink-lemonade:docs'

export function newId(): string {
  return crypto.randomUUID()
}

export function createDoc(name: string): PinkDoc {
  return { id: newId(), name, input: '', steps: [] }
}

/** Load persisted documents from the previous session, or null if none/invalid. */
export function loadDocs(): DocsState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as DocsState
    if (!Array.isArray(parsed.docs) || parsed.docs.length === 0) return null
    return parsed
  } catch {
    return null
  }
}

export function saveDocs(state: DocsState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    /* storage unavailable or over quota — non-fatal */
  }
}
