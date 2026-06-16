// The Watchlists store: one global SQLite file (<userData>/watchlists.db) holding the analyst's
// curated context lists (Corporate subnets, bad ASNs, …). Like enrich/cache.ts, only the DB worker
// loads better-sqlite3, so this stays worker-only. Lists are GLOBAL (shared across every intel DB /
// workspace) — per-workspace lists are a later phase.
//
// Matching: an `ip` list stores IPv4/CIDR entries as integer ranges [lo,hi] (containment) and IPv6
// as exact `norm`; asn/domain/hash lists match on exact `norm`. See watchlistMatch.ts.

import Database from 'better-sqlite3'
import { join, dirname } from 'path'
import { mkdirSync } from 'fs'
import { ipv4ToInt, normalizeAsn, normalizeDomain, normalizeHash, normalizeIpv6, normalizeEntry, type WatchlistKind } from './watchlistMatch'

const KINDS: WatchlistKind[] = ['ip', 'asn', 'domain', 'hash']

const CREATE = `
CREATE TABLE IF NOT EXISTS watchlists (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  kind TEXT NOT NULL,
  color TEXT,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS watchlist_entries (
  list_id INTEGER NOT NULL,
  raw TEXT NOT NULL,
  lo INTEGER,
  hi INTEGER,
  norm TEXT,
  PRIMARY KEY (list_id, raw)
);
CREATE INDEX IF NOT EXISTS ix_wl_entries_list ON watchlist_entries (list_id);
CREATE INDEX IF NOT EXISTS ix_wl_entries_range ON watchlist_entries (lo, hi);
CREATE INDEX IF NOT EXISTS ix_wl_entries_norm ON watchlist_entries (norm);
`

let userDataDir = ''
let conn: Database.Database | null = null

export function initWatchlistPath(dir: string): void {
  userDataDir = dir
}

function db(): Database.Database {
  if (conn) return conn
  if (!userDataDir) throw new Error('watchlist paths not initialized (initWatchlistPath must run first)')
  const path = join(userDataDir, 'watchlists.db')
  mkdirSync(dirname(path), { recursive: true })
  const d = new Database(path)
  d.pragma('journal_mode = WAL')
  d.pragma('synchronous = NORMAL')
  d.exec(CREATE)
  conn = d
  return d
}

export interface WatchlistInfo {
  id: number
  name: string
  kind: WatchlistKind
  color: string | null
  updatedAt: number | null
  count: number
}

/** All lists with their entry counts (for the editor's left rail + the provider status). */
export function listLists(): WatchlistInfo[] {
  const rows = db()
    .prepare(
      `SELECT w.id, w.name, w.kind, w.color, w.updated_at AS updatedAt,
              (SELECT COUNT(*) FROM watchlist_entries e WHERE e.list_id = w.id) AS count
       FROM watchlists w ORDER BY w.name COLLATE NOCASE`
    )
    .all() as Array<{ id: number; name: string; kind: string; color: string | null; updatedAt: number | null; count: number }>
  return rows.map((r) => ({ ...r, kind: r.kind as WatchlistKind }))
}

/** Raw entry lines of one list (what the textarea shows), newest-friendly sorted. */
export function getEntries(listId: number): string[] {
  const rows = db().prepare('SELECT raw FROM watchlist_entries WHERE list_id = ? ORDER BY raw COLLATE NOCASE').all(listId) as Array<{
    raw: string
  }>
  return rows.map((r) => r.raw)
}

export function createList(name: string, kind: WatchlistKind, color: string | null, now: number): WatchlistInfo {
  const nm = name.trim()
  if (!nm) throw new Error('List name is required')
  if (!KINDS.includes(kind)) throw new Error(`Unknown list type: ${kind}`)
  const info = db().prepare('INSERT INTO watchlists (name, kind, color, updated_at) VALUES (?, ?, ?, ?)').run(nm, kind, color, now)
  return { id: Number(info.lastInsertRowid), name: nm, kind, color, updatedAt: now, count: 0 }
}

export function renameList(id: number, name: string, now: number): void {
  const nm = name.trim()
  if (!nm) throw new Error('List name is required')
  db().prepare('UPDATE watchlists SET name = ?, updated_at = ? WHERE id = ?').run(nm, now, id)
}

export function deleteList(id: number): void {
  const d = db()
  const tx = d.transaction(() => {
    d.prepare('DELETE FROM watchlist_entries WHERE list_id = ?').run(id)
    d.prepare('DELETE FROM watchlists WHERE id = ?').run(id)
  })
  tx()
}

/** Replace ALL entries of a list from pasted text. Returns how many were stored + the lines that
 *  didn't parse for this list's kind (so the editor can show "N added, M skipped"). */
export function replaceEntries(listId: number, rawText: string, now: number): { added: number; skipped: string[] } {
  const d = db()
  const row = d.prepare('SELECT kind FROM watchlists WHERE id = ?').get(listId) as { kind: string } | undefined
  if (!row) throw new Error(`No such list: ${listId}`)
  const kind = row.kind as WatchlistKind

  const skipped: string[] = []
  const parsed: Array<{ raw: string; lo: number | null; hi: number | null; norm: string | null }> = []
  const seen = new Set<string>()
  for (const line of rawText.split(/\r?\n/)) {
    const raw = line.trim()
    if (raw === '') continue
    const e = normalizeEntry(kind, raw)
    if (!e) {
      skipped.push(raw)
      continue
    }
    if (seen.has(raw)) continue
    seen.add(raw)
    parsed.push({ raw, lo: e.lo ?? null, hi: e.hi ?? null, norm: e.norm ?? null })
  }

  const tx = d.transaction(() => {
    d.prepare('DELETE FROM watchlist_entries WHERE list_id = ?').run(listId)
    const ins = d.prepare('INSERT OR IGNORE INTO watchlist_entries (list_id, raw, lo, hi, norm) VALUES (?, ?, ?, ?, ?)')
    for (const p of parsed) ins.run(listId, p.raw, p.lo, p.hi, p.norm)
    d.prepare('UPDATE watchlists SET updated_at = ? WHERE id = ?').run(now, listId)
  })
  tx()
  return { added: parsed.length, skipped }
}

/**
 * Names of every list the indicator belongs to. IPs match `ip` lists by range containment (IPv4)
 * or exact IPv6; if `asn` is supplied (resolved upstream from MaxMind) it also matches `asn` lists.
 * Domains/hashes match their kind by exact normalized value.
 */
export function matchIndicator(value: string, kind: string, asn?: number | null): string[] {
  const d = db()
  const names = new Set<string>()
  const addRows = (rows: Array<{ name: string }>): void => {
    for (const r of rows) names.add(r.name)
  }

  if (kind === 'ipv4') {
    const v = ipv4ToInt(value)
    if (v != null) {
      addRows(
        d
          .prepare(
            `SELECT DISTINCT w.name FROM watchlist_entries e JOIN watchlists w ON w.id = e.list_id
             WHERE w.kind = 'ip' AND e.lo IS NOT NULL AND e.lo <= ? AND e.hi >= ?`
          )
          .all(v, v) as Array<{ name: string }>
      )
    }
  } else if (kind === 'ipv6') {
    const v6 = normalizeIpv6(value)
    if (v6) addRows(exactRows(d, 'ip', v6))
  } else if (kind === 'domain') {
    const dn = normalizeDomain(value)
    if (dn) addRows(exactRows(d, 'domain', dn))
  } else if (kind === 'md5' || kind === 'sha1' || kind === 'sha256') {
    const h = normalizeHash(value)
    if (h) addRows(exactRows(d, 'hash', h))
  }

  if ((kind === 'ipv4' || kind === 'ipv6') && asn != null) {
    const a = normalizeAsn(String(asn))
    if (a) addRows(exactRows(d, 'asn', a))
  }

  return [...names]
}

function exactRows(d: Database.Database, kind: WatchlistKind, norm: string): Array<{ name: string }> {
  return d
    .prepare(
      `SELECT DISTINCT w.name FROM watchlist_entries e JOIN watchlists w ON w.id = e.list_id
       WHERE w.kind = ? AND e.norm = ?`
    )
    .all(kind, norm) as Array<{ name: string }>
}

/** True if any `asn` list exists — lets the provider skip the (slower) ASN resolve when pointless. */
export function hasAsnLists(): boolean {
  const r = db().prepare("SELECT 1 FROM watchlists WHERE kind = 'asn' LIMIT 1").get()
  return !!r
}

export function close(): void {
  conn?.close()
  conn = null
}
