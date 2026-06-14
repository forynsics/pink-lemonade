// Recently-opened CSV files, persisted to localStorage so the welcome screen can offer a
// one-click re-open ("quick pivot"). We store only the file path + light metadata — never
// row data (that lives in the temp SQLite db, which is gone after a restart anyway).

export interface RecentFile {
  path: string
  sourceName: string
  rowCount: number
  openedAt: number // epoch ms
}

const STORAGE_KEY = 'pink-lemonade:recent'
const MAX_RECENT = 12

export function loadRecent(): RecentFile[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isRecent)
  } catch {
    return []
  }
}

function isRecent(v: unknown): v is RecentFile {
  const r = v as Record<string, unknown>
  return !!r && typeof r.path === 'string' && r.path !== '' && typeof r.sourceName === 'string'
}

/** Add (or move-to-front) a file. De-dupes by path, newest first, capped at MAX_RECENT. */
export function addRecent(list: RecentFile[], file: RecentFile): RecentFile[] {
  const rest = list.filter((f) => f.path !== file.path)
  return [file, ...rest].slice(0, MAX_RECENT)
}

export function removeRecent(list: RecentFile[], path: string): RecentFile[] {
  return list.filter((f) => f.path !== path)
}

export function saveRecent(list: RecentFile[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, MAX_RECENT)))
  } catch {
    /* storage unavailable or over quota — non-fatal */
  }
}
