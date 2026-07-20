import { ipcMain, dialog, BrowserWindow } from 'electron'
import type { WebContents } from 'electron'
import { basename, extname, join, relative } from 'path'
import { readdirSync, statSync } from 'fs'
import { randomUUID } from 'crypto'
import * as dbw from './dbClient'
import type { Filter, QueryOpts, Sort } from './sql'
import type { CsvTableMeta, SourceInfo } from './db'
import { resolveTechnique } from '../ai/attack'
import { spansByColumn, envelopeOf } from '../ai/timecols'
import type { WsSource } from '../ai/types'

// Registers the csv:* / ws:* IPC surface. Every DB operation is forwarded to the worker thread
// (dbClient) so a slow query never blocks the main process; the renderer only receives small
// result sets. Ingest/count progress streams back over 'csv:progress' / 'csv:count-progress'.

interface OpenResult {
  tabId: string
  sourceName: string
  columns: Array<{ name: string; original: string }>
  rowCount: number
  dbPath: string
}

export function registerCsvIpc(): void {
  // Pick (dialog) and ingest are separate so the renderer shows an import overlay only
  // during ingest — not while the user is still choosing a file.
  ipcMain.handle('csv:pick', (e) => doPick(e.sender))
  // Bulk import: pick several files at once, or a whole folder of CSVs (e.g. a parsed KAPE package).
  ipcMain.handle('csv:pickMany', (e) => doPickMany(e.sender))
  ipcMain.handle('csv:pickFolder', (e) => doPickFolder(e.sender))
  ipcMain.handle('csv:ingest', (e, { tabId, path }: { tabId: string; path: string }) =>
    doIngest(e.sender, tabId, path)
  )

  // Abort an in-flight ingest (the worker holds the AbortController, keyed by this id).
  ipcMain.handle('csv:cancel', (_e, { tabId }: { tabId: string }) => {
    dbw.cancel(tabId)
    return { canceled: true }
  })

  ipcMain.handle('csv:query', async (_e, { tabId, opts }: { tabId: string; opts: QueryOpts }) => {
    const o = normalizeOpts(opts)
    // On a large table, build the matching column index before sorting (Scale #3) — without it,
    // a deep sorted scroll re-sorts the whole set per window. One-time, cached. Runs in the worker.
    if (o.sort) await dbw.call('ensureSortIndex', tabId, o.sort.col, !!o.sort.numeric)
    return dbw.call('queryRows', tabId, o)
  })

  // Prepare a filtered/searched view: materialize its matching rowids (Scale #1b) and return the
  // match count. Chunked + cancelable in the worker; the running total streams over
  // 'csv:count-progress'. Resolves with { count } or { canceled } if a newer request superseded it.
  ipcMain.handle(
    'csv:count',
    async (
      e,
      { tabId, reqId, filters, search }: { tabId: string; reqId: number; filters?: Filter[]; search?: string }
    ) => {
      const f = normalizeFilters(filters)
      const s = normalizeSearch(search)
      // A null count means this request was SUPERSEDED by a newer one (→ canceled). A real error is a
      // different thing and must surface — swallowing it as `canceled` made a failed filtered count
      // read as "nothing here", which in a forensics tool is a wrong answer, not an absent one.
      const count = await dbw.count(tabId, reqId, f, s ?? '', (p) => {
        if (!e.sender.isDestroyed()) {
          e.sender.send('csv:count-progress', { tabId, reqId, count: p.count, scanned: p.scanned, max: p.max })
        }
      })
      return count == null ? { canceled: true } : { count }
    }
  )

  // Distinct values + count, computed in cancelable chunks in the worker; the running scan streams
  // progress over 'csv:distinct-progress'. A newer reqId on the same tab supersedes the prior scan.
  ipcMain.handle(
    'csv:distinct',
    async (
      e,
      { tabId, col, filters, limit, reqId }: { tabId: string; col: string; filters?: Filter[]; limit?: number; reqId?: number }
    ) => {
      const f = normalizeFilters(filters)
      const res = await dbw.distinct(tabId, reqId ?? 0, col, f, limit ?? 1000, (p) => {
        if (!e.sender.isDestroyed()) {
          e.sender.send('csv:distinct-progress', { tabId, reqId, scanned: p.scanned, count: p.count, max: p.max })
        }
      })
      return res == null ? { canceled: true } : res
    }
  )
  ipcMain.handle('csv:distinctCancel', (_e, { tabId }: { tabId: string }) => {
    dbw.distinctCancel(tabId)
    return null
  })

  // Intel sweep: scan a source's rows for an intel set, recording sightings (intel_hits). Chunked +
  // cancelable in the worker; scan progress streams over 'csv:sweep-progress'. Resolves with the
  // { sightings, hits } counts, or { canceled } if a newer sweep superseded it.
  ipcMain.handle(
    'csv:sweep',
    async (
      e,
      {
        tabId,
        reqId,
        entries,
        columns,
        mode
      }: {
        tabId: string
        reqId: number
        entries: Array<{ value: string; kind: string }>
        columns?: string[]
        mode?: 'replace' | 'add'
      }
    ) => {
      const res = await dbw.sweep(tabId, reqId, entries, columns, mode === 'add' ? 'add' : 'replace', (p) => {
        if (!e.sender.isDestroyed()) {
          e.sender.send('csv:sweep-progress', { tabId, reqId, sightings: p.sightings, scanned: p.scanned, max: p.max })
        }
      })
      return res == null ? { canceled: true } : res
    }
  )
  ipcMain.handle('csv:sweepCancel', (_e, { tabId }: { tabId: string }) => {
    dbw.sweepCancel(tabId)
    return null
  })
  ipcMain.handle('csv:sightingList', (_e, { wsId, sourceId }: { wsId: string; sourceId: number }) =>
    dbw.call('listSightings', wsId, sourceId)
  )
  ipcMain.handle('csv:sightingsAll', (_e, { wsId }: { wsId: string }) => dbw.call('sightingsByIndicator', wsId))
  // Workspace-wide free-string "find in files": which sources contain `term` + the matching rowids
  // (for click-to-jump). Optionally scoped to one group. Fans out in the worker (non-blocking).
  ipcMain.handle(
    'csv:findInFiles',
    (_e, { wsId, term, group, ridCap }: { wsId: string; term: string; group?: string | null; ridCap?: number }) =>
      dbw.call('findInFiles', wsId, term, { ...(group !== undefined ? { group } : {}), ...(ridCap != null ? { ridCap } : {}) })
  )
  ipcMain.handle('csv:sightingSummary', (_e, { wsId, sourceId }: { wsId: string; sourceId: number }) =>
    dbw.call('sightingSummary', wsId, sourceId)
  )
  ipcMain.handle(
    'csv:sightingClear',
    (_e, { wsId, sourceId, indicator, rid }: { wsId: string; sourceId: number; indicator?: string; rid?: number }) =>
      dbw.call('clearSightings', wsId, sourceId, { indicator, rid }).then(() => null)
  )

  ipcMain.handle('csv:longest', (_e, { tabId, col }: { tabId: string; col: string }) =>
    dbw.call('getColumnLongest', tabId, col)
  )

  // Ordinal of a row (by rowid) in the current unsorted filtered view — re-centers the time-pivot anchor.
  ipcMain.handle(
    'csv:locate',
    (_e, { tabId, rid, filters, search }: { tabId: string; rid: number; filters?: Filter[]; search?: string }) =>
      dbw.call('locateRow', tabId, rid, normalizeFilters(filters), normalizeSearch(search))
  )

  ipcMain.handle(
    'csv:values',
    async (_e, { tabId, col, filters }: { tabId: string; col: string; filters?: Filter[] }) => ({
      values: await dbw.call<string[]>('getColumnValues', tabId, col, normalizeFilters(filters)),
      truncated: false
    })
  )

  ipcMain.handle('csv:stats', (_e, { tabId, col }: { tabId: string; col: string }) =>
    dbw.call('getColumnStats', tabId, col)
  )

  // Export the whole current view (all rows under the active filters/search/sort) to a CSV file.
  // The save dialog runs here (main); the worker streams every matching row to the chosen path so a
  // multi-million-row export neither blocks the UI nor round-trips through the renderer.
  ipcMain.handle(
    'csv:export',
    async (
      e,
      {
        tabId,
        defaultName,
        opts
      }: {
        tabId: string
        defaultName?: string
        opts: { filters?: Filter[]; search?: string; sort?: Sort; columns?: string[] }
      }
    ): Promise<{ canceled: true } | { path: string; rows: number }> => {
      const win = BrowserWindow.fromWebContents(e.sender)
      const name = defaultName && defaultName.toLowerCase().endsWith('.csv') ? defaultName : `${defaultName || 'export'}.csv`
      const dialogOpts = {
        defaultPath: name,
        filters: [
          { name: 'CSV', extensions: ['csv'] },
          { name: 'All files', extensions: ['*'] }
        ]
      }
      const result = win ? await dialog.showSaveDialog(win, dialogOpts) : await dialog.showSaveDialog(dialogOpts)
      if (result.canceled || !result.filePath) return { canceled: true }
      const o = {
        filters: normalizeFilters(opts?.filters),
        search: normalizeSearch(opts?.search),
        sort: normalizeSort(opts?.sort),
        // Keep only well-formed c-names (SQL-injection boundary); exportRows maps them to columns.
        columns: Array.isArray(opts?.columns) ? opts.columns.filter((c) => /^c\d+$/.test(c)) : undefined
      }
      const res = await dbw.call<{ rows: number }>('exportRows', tabId, o, result.filePath)
      return { path: result.filePath, rows: res.rows }
    }
  )

  ipcMain.handle('csv:close', (_e, { tabId }: { tabId: string }) => dbw.call('closeTab', tabId).then(() => null))

  // ---- Workspaces (capstone): one db holds many sources ----
  ipcMain.handle('ws:create', (_e, { wsId, name }: { wsId: string; name: string }) =>
    dbw.call('createWorkspace', wsId, name)
  )
  ipcMain.handle('ws:open', (_e, { wsId, dbPath }: { wsId: string; dbPath: string }) =>
    dbw.call('openWorkspace', wsId, dbPath)
  )
  ipcMain.handle('ws:close', (_e, { wsId }: { wsId: string }) => dbw.call('closeWorkspace', wsId).then(() => null))
  ipcMain.handle('ws:delete', (_e, { dbPath }: { dbPath: string }) => dbw.call('deleteWorkspace', dbPath).then(() => null))
  ipcMain.handle('ws:addSource', (e, { wsId, path }: { wsId: string; path: string }) =>
    doAddSource(e.sender, wsId, path)
  )
  ipcMain.handle('ws:addXlsx', (e, { wsId, path }: { wsId: string; path: string }) =>
    doAddXlsx(e.sender, wsId, path)
  )
  ipcMain.handle('ws:rename', (_e, { wsId, name }: { wsId: string; name: string }) =>
    dbw.call('renameWorkspace', wsId, name).then(() => null)
  )
  ipcMain.handle('ws:setIntelMode', (_e, { wsId, mode }: { wsId: string; mode: 'global' | 'workspace' }) =>
    dbw.call('setWorkspaceIntelMode', wsId, mode).then(() => null)
  )
  ipcMain.handle('ws:removeSource', (_e, { wsId, sourceId }: { wsId: string; sourceId: number }) =>
    dbw.call('removeSource', wsId, sourceId).then(() => null)
  )
  ipcMain.handle('ws:renameSource', (_e, { wsId, sourceId, name }: { wsId: string; sourceId: number; name: string }) =>
    dbw.call('renameSource', wsId, sourceId, name).then(() => null)
  )
  ipcMain.handle('ws:setSourceGroup', (_e, { wsId, sourceId, group }: { wsId: string; sourceId: number; group: string | null }) =>
    dbw.call('setSourceGroup', wsId, sourceId, group).then(() => null)
  )
  ipcMain.handle(
    'ws:addDerivedColumns',
    (
      _e,
      { wsId, sourceId, jsonCol, fields }: { wsId: string; sourceId: number; jsonCol: string; fields: Array<{ path: string; displayName: string }> }
    ) => dbw.call('addDerivedColumns', wsId, sourceId, jsonCol, fields) // returns the new ColumnMap[]
  )
  ipcMain.handle('ws:buildTimeline', (_e, { wsId, header, rows }: { wsId: string; header: string[]; rows: string[][] }) =>
    dbw.call('buildTimelineSource', wsId, header, rows)
  )

  // Row tags: list all tags for a source, and set/clear a tag on a set of rows.
  ipcMain.handle('ws:tagList', (_e, { wsId, sourceId }: { wsId: string; sourceId: number }) =>
    dbw.call('listTags', wsId, sourceId)
  )
  // AI-accountability marks (✨): the renderer loads them for the grid marker; clear resets them.
  ipcMain.handle('ws:aiMarkList', (_e, { wsId, sourceId }: { wsId: string; sourceId: number }) =>
    dbw.call('listAiMarks', wsId, sourceId)
  )
  ipcMain.handle('ws:aiMarkClear', (_e, { wsId, sourceId }: { wsId: string; sourceId: number }) =>
    dbw.call('clearAiMarks', wsId, sourceId).then(() => null)
  )
  // Events (the Artifact Constellation) — the renderer lists/clears them; the AI writes via record_event.
  ipcMain.handle('ws:eventList', (_e, { wsId }: { wsId: string }) => dbw.call('listEvents', wsId))
  ipcMain.handle('ws:eventDelete', (_e, { wsId, id }: { wsId: string; id: string }) => dbw.call('deleteEvent', wsId, id).then(() => null))
  ipcMain.handle('ws:eventClear', (_e, { wsId }: { wsId: string }) => dbw.call('clearEvents', wsId).then(() => null))

  // Analyst event editing — the INTERPRETATION only (label/description/technique, manual create from
  // selected rows, evidence re-grouping). Never mutates source rows; analyst events are flagged + protected.
  ipcMain.handle(
    'ws:eventUpdate',
    (
      _e,
      { wsId, id, label, description, technique, users }: { wsId: string; id: string; label: string; description: string | null; technique: string | null; users: string[] }
    ) => {
      const resolved = technique && technique.trim() ? resolveTechnique(technique.trim())?.display ?? technique.trim() : null
      return dbw.call('updateEvent', wsId, id, { label, description, technique: resolved, users: users ?? [] }).then(() => null)
    }
  )
  ipcMain.handle('ws:evidenceDelete', (_e, { wsId, evidenceId }: { wsId: string; evidenceId: number }) =>
    dbw.call('deleteEvidence', wsId, evidenceId).then(() => null)
  )
  ipcMain.handle(
    'ws:eventCreateFromRows',
    async (
      _e,
      {
        wsId,
        sourceId,
        sourceName,
        rids,
        rows,
        columns,
        label,
        description,
        technique,
        users,
        eventId
      }: {
        wsId: string
        sourceId: number
        sourceName: string
        rids: number[]
        rows: string[][]
        columns: Array<{ name: string; original: string; time: string | null }>
        label: string
        description: string | null
        technique: string | null
        users: string[]
        /** When set, ATTACH the rows as evidence to this existing event instead of creating a new one. */
        eventId?: string
      }
    ) => {
      // Spans are DERIVED from the selected rows' time cells (same helper the AI uses) — grounded in real
      // data, not authored. `columns` arrive in canonical c0..cN order, aligned with the row arrays.
      const src = { sourceId, name: sourceName, columns } as unknown as WsSource
      const spans = spansByColumn(src, rows)
      const { tsMin, tsMax } = envelopeOf(spans)
      const capped = rids.slice(0, 500)
      // A readable, selection-specific label (NOT '') so two manual evidence items from the same source
      // on one event don't collide on recordEvent's (source_id, matched) dedup key — re-attaching the
      // exact same rows is idempotent; a different selection appends instead of clobbering.
      const matched =
        capped.length === 0 ? 'selected rows' : capped.length === 1 ? `row ${capped[0]}` : `rows ${Math.min(...capped)}–${Math.max(...capped)} ×${capped.length}`
      const evidence = [{ sourceId, sourceName, matched, count: capped.length, rids: capped, spans, tsMin, tsMax }]

      // Attach to an existing event: merge the rows in as new evidence, preserving the event's
      // interpretation (label/description/technique) and ownership (actor). The evidence merge in
      // recordEvent is additive, so this corroborates the event without touching its meaning.
      if (eventId) {
        const existing = (await dbw.call('getEvent', wsId, eventId)) as
          | { id: string; label: string; description: string | null; technique: string | null; actor: 'ai' | 'analyst' }
          | null
        if (!existing) throw new Error('That event no longer exists — reopen the dialog to pick another.')
        // users omitted (undefined) → leave the event's curated user set untouched.
        await dbw.call('recordEvent', wsId, { id: existing.id, label: existing.label, description: existing.description, technique: existing.technique }, evidence, existing.actor)
        await dbw.call('setAiMarks', wsId, sourceId, capped, `Timeline evidence: ${existing.label}`)
        return { id: existing.id }
      }

      const resolved = technique && technique.trim() ? resolveTechnique(technique.trim())?.display ?? technique.trim() : null
      // Random id (never the AI's label-slug) so a manual event never collides with — or is merged into — an AI one.
      const id = `event:analyst:${randomUUID()}`
      await dbw.call('recordEvent', wsId, { id, label: label.slice(0, 300), description: description || null, technique: resolved, users: users ?? [] }, evidence, 'analyst')
      await dbw.call('setAiMarks', wsId, sourceId, capped, `Timeline evidence: ${label}`)
      return { id }
    }
  )
  // IOC catalog — the renderer lists/clears; the AI writes via record_ioc. Sending to Intel is manual.
  ipcMain.handle('ws:iocList', (_e, { wsId }: { wsId: string }) => dbw.call('listIocs', wsId))
  // Content-based IOC↔event linkage: which events' evidence rows actually contain each IOC value
  // (drives the constellation's IOCs-view edges, unioned with the renderer's label/text match).
  ipcMain.handle('ws:iocEventLinks', (_e, { wsId }: { wsId: string }) => dbw.call('iocEventLinks', wsId))
  ipcMain.handle('ws:iocDelete', (_e, { wsId, id }: { wsId: string; id: string }) => dbw.call('deleteIoc', wsId, id).then(() => null))
  ipcMain.handle('ws:iocClear', (_e, { wsId }: { wsId: string }) => dbw.call('clearIocs', wsId).then(() => null))

  // Leads (AI hypotheses): read + the analyst's review actions (dismiss, clear, promote-to-event).
  ipcMain.handle('ws:leadList', (_e, { wsId }: { wsId: string }) => dbw.call('listLeads', wsId))
  ipcMain.handle('ws:leadDelete', (_e, { wsId, id }: { wsId: string; id: string }) => dbw.call('deleteLead', wsId, id).then(() => null))
  ipcMain.handle('ws:leadClear', (_e, { wsId }: { wsId: string }) => dbw.call('clearLeads', wsId).then(() => null))
  ipcMain.handle('ws:leadPromote', (_e, { wsId, id }: { wsId: string; id: string }) => dbw.call('promoteLead', wsId, id))

  // Case Report: the adjudication surface. Verdicts are the ANALYST's — there is deliberately no
  // agent-facing setter, only a read (list_case_report), so the agent can act on a rejection
  // without being able to overrule one.
  ipcMain.handle('ws:caseReport', (_e, { wsId }: { wsId: string }) => dbw.call('listCaseReport', wsId))
  ipcMain.handle(
    'ws:caseReview',
    (_e, { wsId, kind, id, verdict, reason }: { wsId: string; kind: string; id: string; verdict: string; reason?: string | null }) =>
      dbw.call('setFindingReview', wsId, kind, id, verdict, reason ?? null, 'analyst')
  )

  // Negative findings (proven absences + evidence gaps).
  ipcMain.handle('ws:negativeList', (_e, { wsId }: { wsId: string }) => dbw.call('listNegatives', wsId))
  ipcMain.handle('ws:negativeDelete', (_e, { wsId, id }: { wsId: string; id: string }) => dbw.call('deleteNegative', wsId, id).then(() => null))

  // Systems & Accounts. The list is the derived spine (source groups + event attribution) overlaid
  // with curated records, so it is never empty just because nobody has curated anything yet.
  ipcMain.handle('ws:entityList', (_e, { wsId }: { wsId: string }) => dbw.call('listEntities', wsId))
  // The panel is the analyst's hand — the agent never reaches this handler, it goes through runTool.
  ipcMain.handle('ws:entityUpsert', (_e, { wsId, patch }: { wsId: string; patch: unknown }) => dbw.call('upsertEntity', wsId, patch, [], 'analyst'))
  ipcMain.handle('ws:entityDelete', (_e, { wsId, id }: { wsId: string; id: string }) => dbw.call('deleteEntity', wsId, id).then(() => null))
  ipcMain.handle('ws:entityAliasAdd', (_e, { wsId, id, alias }: { wsId: string; id: string; alias: string }) =>
    dbw.call('addEntityAlias', wsId, id, alias)
  )
  ipcMain.handle('ws:entityLink', (_e, { wsId, kind, primary, other, same, reason }: { wsId: string; kind: string; primary: string; other: string; same: boolean; reason?: string }) =>
    dbw.call('linkEntities', wsId, kind, primary, other, same, reason ?? null, 'analyst')
  )
  ipcMain.handle('ws:entityAliasRemove', (_e, { wsId, id, alias }: { wsId: string; id: string; alias: string }) =>
    dbw.call('removeEntityAlias', wsId, id, alias).then(() => null)
  )

  // Investigation plan + progress notes (the AI's persistent, analyst-editable working state).
  ipcMain.handle('ws:investigationGet', (_e, { wsId }: { wsId: string }) => dbw.call('getInvestigation', wsId))
  ipcMain.handle('ws:investigationSetPlan', (_e, { wsId, plan }: { wsId: string; plan: unknown[] }) =>
    dbw.call('setInvestigationPlan', wsId, plan).then(() => null)
  )
  ipcMain.handle('ws:investigationSetNotes', (_e, { wsId, notes }: { wsId: string; notes: string }) =>
    dbw.call('setInvestigationNotes', wsId, notes).then(() => null)
  )

  ipcMain.handle(
    'ws:tagSet',
    (_e, { wsId, sourceId, rids, tag }: { wsId: string; sourceId: number; rids: number[]; tag: string | null }) =>
      dbw.call('setTags', wsId, sourceId, rids, tag).then(() => null)
  )
  // Per-tag counts for the active source under the current filtered view (tag filter excluded).
  ipcMain.handle(
    'csv:tagCounts',
    (_e, { tabId, filters, search }: { tabId: string; filters?: Filter[]; search?: string }) =>
      dbw.call('getTagCounts', tabId, normalizeFilters(filters), normalizeSearch(search))
  )
  // Bulk-tag every row matching the current view (filters + search), or clear if tag is null.
  ipcMain.handle(
    'ws:tagByFilter',
    (
      _e,
      { wsId, sourceId, filters, search, tag }: { wsId: string; sourceId: number; filters?: Filter[]; search?: string; tag: string | null }
    ) =>
      dbw.call('tagByFilter', wsId, sourceId, normalizeFilters(filters), normalizeSearch(search), typeof tag === 'string' ? tag : null)
  )

  // The AI agent's SQL history for a case — what it ran, what was refused, and what came back.
  // Read-only surface: the analyst reviews the trail, nothing edits it.
  ipcMain.handle('ws:agentSqlLog', (_e, { wsId, limit }: { wsId: string; limit?: number }) =>
    dbw.call('listAgentSql', wsId, limit ?? 200)
  )

  // Workspace storage folder (used as the Open-Workspace default + where new workspaces are saved).
  ipcMain.handle('ws:getDir', () => dbw.call('getWorkspaceDir'))
  ipcMain.handle('ws:setDir', (_e, { dir }: { dir: string }) => dbw.call('setWorkspaceDir', dir))
  ipcMain.handle('ws:pickDir', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts = {
      properties: ['openDirectory' as const, 'createDirectory' as const],
      defaultPath: await dbw.call<string>('getWorkspaceDir')
    }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
  })

  // Evidence root: the one tree the AI agent may import from. Analyst-set only — deliberately no
  // agent-facing setter, or the containment it provides would be theatre.
  ipcMain.handle('ws:getEvidenceRoot', () => dbw.call('getEvidenceRoot'))
  ipcMain.handle('ws:setEvidenceRoot', (_e, { dir }: { dir: string | null }) =>
    dbw.call('setEvidenceRoot', typeof dir === 'string' && dir ? dir : null)
  )
  ipcMain.handle('ws:pickEvidenceRoot', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const current = await dbw.call<string | null>('getEvidenceRoot')
    const opts = {
      properties: ['openDirectory' as const, 'createDirectory' as const],
      title: 'Choose the evidence folder your AI agent may import from',
      ...(current ? { defaultPath: current } : {})
    }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
  })

  // Re-open a persistent session db by path (no re-ingest) — resume on restart or "Open Database…".
  ipcMain.handle('csv:open', async (_e, { tabId, dbPath }: { tabId: string; dbPath: string }): Promise<OpenResult> => {
    const meta = await dbw.call<CsvTableMeta>('openDb', tabId, dbPath)
    return { tabId, sourceName: meta.sourceName, columns: meta.columns, rowCount: meta.rowCount, dbPath: meta.dbPath }
  })

  // Pick a .workspace/.db to open directly. Returns its path, or null if canceled.
  ipcMain.handle('csv:pickDb', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts = {
      properties: ['openFile' as const],
      defaultPath: await dbw.call<string>('getWorkspaceDir'),
      filters: [{ name: 'Pink Lemonade workspace', extensions: ['workspace', 'db'] }]
    }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
  })

  // Delete a session's db files (Home "delete session").
  ipcMain.handle('csv:deleteDb', (_e, { dbPath }: { dbPath: string }) => dbw.call('deleteDb', dbPath).then(() => null))
}

async function doPick(sender: WebContents): Promise<{ path: string; sourceName: string } | null> {
  // Test hook: the Playwright driver can't pick a file in the native dialog, so when
  // PL_CSV_TEST_FILE is set we return that path directly. No effect in production.
  if (process.env.PL_CSV_TEST_FILE) {
    const p = process.env.PL_CSV_TEST_FILE
    return { path: p, sourceName: basename(p) }
  }
  const win = BrowserWindow.fromWebContents(sender)
  const dialogOpts = {
    properties: ['openFile' as const],
    filters: [
      { name: 'Tabular data & Excel', extensions: ['csv', 'tsv', 'txt', 'log', 'xlsx', 'xlsm'] },
      { name: 'All files', extensions: ['*'] }
    ]
  }
  const r = win ? await dialog.showOpenDialog(win, dialogOpts) : await dialog.showOpenDialog(dialogOpts)
  if (r.canceled || r.filePaths.length === 0) return null
  return { path: r.filePaths[0], sourceName: basename(r.filePaths[0]) }
}

// Extensions a bulk/folder import will ingest as sources. Excel workbooks (.xlsx/.xlsm) become one
// source per non-empty sheet; legacy binary .xls is unsupported (exceljs can't read it).
const TABULAR_EXT = new Set(['.csv', '.tsv', '.xlsx', '.xlsm'])
const MAX_BULK_FILES = 500 // guard against picking an enormous tree

/** Pick several tabular files at once (each becomes a source). */
async function doPickMany(sender: WebContents): Promise<Array<{ path: string; sourceName: string }> | null> {
  const win = BrowserWindow.fromWebContents(sender)
  const opts = {
    properties: ['openFile' as const, 'multiSelections' as const],
    filters: [
      { name: 'Tabular data & Excel', extensions: ['csv', 'tsv', 'txt', 'log', 'xlsx', 'xlsm'] },
      { name: 'All files', extensions: ['*'] }
    ]
  }
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  if (r.canceled || r.filePaths.length === 0) return null
  return r.filePaths.slice(0, MAX_BULK_FILES).map((p) => ({ path: p, sourceName: basename(p) }))
}

/** Recursively collect every supported file (csv/tsv/xlsx/xlsm) under `dir` (KAPE writes its module
 *  outputs as CSVs, often nested in subfolders), capped so a stray huge tree can't hang the scan. */
function walkCsvs(dir: string, out: Array<{ path: string; size: number }>): void {
  if (out.length >= MAX_BULK_FILES) return
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (out.length >= MAX_BULK_FILES) return
    const full = join(dir, name)
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) walkCsvs(full, out)
    else if (TABULAR_EXT.has(extname(name).toLowerCase())) out.push({ path: full, size: st.size })
  }
}

/** Pick a folder and return every CSV/TSV inside it (recursively) — with size + relative path so the
 *  renderer can show a selection dialog before importing. */
async function doPickFolder(
  sender: WebContents
): Promise<{ name: string; files: Array<{ path: string; sourceName: string; relPath: string; size: number }> } | null> {
  const win = BrowserWindow.fromWebContents(sender)
  const opts = { properties: ['openDirectory' as const] }
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  if (r.canceled || r.filePaths.length === 0) return null
  const dir = r.filePaths[0]
  const found: Array<{ path: string; size: number }> = []
  walkCsvs(dir, found)
  return {
    name: basename(dir),
    files: found.map((f) => ({ path: f.path, sourceName: basename(f.path), relPath: relative(dir, f.path), size: f.size }))
  }
}

async function doIngest(sender: WebContents, tabId: string, filePath: string): Promise<OpenResult | null> {
  const meta = await dbw.ingest<CsvTableMeta | null>(
    'ingestCsv',
    { tabId, filePath, sourceName: basename(filePath) },
    tabId,
    (p) => {
      if (!sender.isDestroyed()) sender.send('csv:progress', { tabId, ...p, phase: 'parsing' })
    }
  )
  if (meta == null) return null // canceled
  if (!sender.isDestroyed()) {
    sender.send('csv:progress', { tabId, bytes: 0, rows: meta.rowCount, total: 0, phase: 'done' })
  }
  return { tabId, sourceName: meta.sourceName, columns: meta.columns, rowCount: meta.rowCount, dbPath: meta.dbPath }
}

/** Ingest an Excel workbook as one source per worksheet; progress is keyed on the workspace id. */
async function doAddXlsx(sender: WebContents, wsId: string, filePath: string): Promise<SourceInfo[] | null> {
  const srcs = await dbw.ingest<SourceInfo[] | null>(
    'addXlsxSources',
    { wsId, filePath, sourceName: basename(filePath) },
    wsId,
    (p) => {
      if (!sender.isDestroyed()) sender.send('csv:progress', { tabId: wsId, ...p, phase: 'parsing' })
    }
  )
  if (srcs == null) return null // canceled
  if (!sender.isDestroyed()) {
    const rows = srcs.reduce((a, s) => a + s.rowCount, 0)
    sender.send('csv:progress', { tabId: wsId, bytes: 0, rows, total: 0, phase: 'done' })
  }
  return srcs
}

/** Ingest a CSV as a new source in an open workspace; progress is keyed on the workspace id. */
async function doAddSource(sender: WebContents, wsId: string, filePath: string): Promise<SourceInfo | null> {
  const src = await dbw.ingest<SourceInfo | null>(
    'addSource',
    { wsId, filePath, sourceName: basename(filePath) },
    wsId,
    (p) => {
      if (!sender.isDestroyed()) sender.send('csv:progress', { tabId: wsId, ...p, phase: 'parsing' })
    }
  )
  if (src == null) return null // canceled
  if (!sender.isDestroyed()) {
    sender.send('csv:progress', { tabId: wsId, bytes: 0, rows: src.rowCount, total: 0, phase: 'done' })
  }
  return src
}

export function normalizeOpts(opts: QueryOpts): QueryOpts {
  return {
    limit: Number(opts?.limit) || 100,
    offset: Number(opts?.offset) || 0,
    sort: normalizeSort(opts?.sort),
    filters: normalizeFilters(opts?.filters),
    search: normalizeSearch(opts?.search)
  }
}

function normalizeSearch(search?: string): string | undefined {
  if (typeof search !== 'string') return undefined
  const t = search.trim()
  return t === '' ? undefined : t
}

function normalizeSort(sort?: Sort): Sort | undefined {
  if (!sort || typeof sort.col !== 'string') return undefined
  return { col: sort.col, dir: sort.dir === 'desc' ? 'desc' : 'asc', numeric: !!sort.numeric }
}

export function normalizeFilters(filters?: Filter[]): Filter[] | undefined {
  if (!Array.isArray(filters) || filters.length === 0) return undefined
  const out: Filter[] = []
  for (const f of filters) {
    if (!f) continue
    if (f.op === 'tag') {
      const tags = Array.isArray(f.tags) ? f.tags.filter((t) => typeof t === 'string' && t) : []
      if (tags.length > 0) out.push({ op: 'tag', tags, ...(f.exclude ? { exclude: true } : {}) })
      continue
    }
    if (f.op === 'sighting') {
      const inds = Array.isArray(f.indicators) ? f.indicators.filter((s) => typeof s === 'string' && s) : undefined
      out.push({
        op: 'sighting',
        ...(inds && inds.length > 0 ? { indicators: inds } : {}),
        ...(f.exclude ? { exclude: true } : {})
      })
      continue
    }
    if (f.op === 'aimark') {
      out.push({ op: 'aimark', ...(f.exclude ? { exclude: true } : {}) })
      continue
    }
    if (f.op === 'rids') {
      const rids = Array.isArray(f.rids) ? f.rids.filter((n) => Number.isInteger(n)) : []
      out.push({ op: 'rids', rids })
      continue
    }
    if (typeof f.col !== 'string') continue
    if (f.op === 'in') {
      const values = Array.isArray(f.values) ? f.values.map(String) : []
      if (values.length > 0) out.push({ col: f.col, op: 'in', values })
    } else if (f.op === 'timearound') {
      const tkind = f.tkind === 'iso' || f.tkind === 'epoch_ms' ? f.tkind : 'epoch_s'
      const deltaSec = Math.max(0, Math.trunc(Number(f.deltaSec)) || 0)
      if (deltaSec > 0) out.push({ col: f.col, op: 'timearound', value: String(f.value ?? ''), tkind, deltaSec })
    } else if (f.op === 'timerange') {
      const tkind = f.tkind === 'iso' || f.tkind === 'epoch_ms' ? f.tkind : 'epoch_s'
      // Bounds are epoch SECONDS, but accept an ISO-8601 string too: find_rows' time_from/time_to do,
      // and demanding epoch here silently dropped the whole clause — turning a filtered query into an
      // unfiltered one that returned plausible-looking wrong numbers.
      // A bound that was SUPPLIED but cannot be parsed must fail loudly. Dropping it silently turns a
      // filtered query into an unfiltered one (or a half-open range), and the caller gets a
      // plausible-looking wrong count with no signal — in a forensics tool that is the worst outcome,
      // because a wrongly-empty or wrongly-broad result is indistinguishable from a true one.
      const num = (v: unknown, side: 'from' | 'to'): number | undefined => {
        if (v == null || v === '') return undefined
        const n = Number(v)
        if (Number.isFinite(n)) return n
        const ms = Date.parse(String(v))
        if (Number.isFinite(ms)) return Math.floor(ms / 1000)
        throw new Error(
          `timerange "${side}" is not a valid time: ${JSON.stringify(v)}. Pass epoch SECONDS (e.g. 1700000000) or an ISO-8601 timestamp (e.g. "2023-11-14T22:13:20Z").`
        )
      }
      const from = num(f.from, 'from')
      const to = num(f.to, 'to')
      if (from != null || to != null) out.push({ col: f.col, op: 'timerange', tkind, from, to })
    } else {
      const op = f.op === 'eq' ? 'eq' : f.op === 'neq' ? 'neq' : f.op === 'nlike' ? 'nlike' : 'like'
      out.push({ col: f.col, op, value: String(f.value ?? '') })
    }
  }
  return out.length > 0 ? out : undefined
}
