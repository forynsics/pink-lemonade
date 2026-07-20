import { contextBridge, ipcRenderer } from 'electron'

// The only surface the renderer can reach into the main process through.
// Kept deliberately small; transforms never need it. File I/O is opt-in.
const api = {
  openFile: (): Promise<{
    name: string
    content: string
    size: number
    tooLarge?: boolean
  } | null> => ipcRenderer.invoke('file:open'),
  saveFile: (content: string, defaultName?: string): Promise<string | null> =>
    ipcRenderer.invoke('file:save', { content, defaultName }),

  // CSV viewer: data lives in a main-process SQLite db; these return only small result sets.
  csv: {
    pick: () => ipcRenderer.invoke('csv:pick'),
    pickMany: () => ipcRenderer.invoke('csv:pickMany'),
    pickFolder: () => ipcRenderer.invoke('csv:pickFolder'),
    pickDb: () => ipcRenderer.invoke('csv:pickDb'),
    ingest: (tabId: string, path: string) => ipcRenderer.invoke('csv:ingest', { tabId, path }),
    open: (tabId: string, dbPath: string) => ipcRenderer.invoke('csv:open', { tabId, dbPath }),
    deleteDb: (dbPath: string) => ipcRenderer.invoke('csv:deleteDb', { dbPath }),
    // Workspaces (capstone): one db holds many sources.
    wsCreate: (wsId: string, name: string) => ipcRenderer.invoke('ws:create', { wsId, name }),
    wsOpen: (wsId: string, dbPath: string) => ipcRenderer.invoke('ws:open', { wsId, dbPath }),
    wsClose: (wsId: string) => ipcRenderer.invoke('ws:close', { wsId }),
    wsDelete: (dbPath: string) => ipcRenderer.invoke('ws:delete', { dbPath }),
    wsAddSource: (wsId: string, path: string) => ipcRenderer.invoke('ws:addSource', { wsId, path }),
    wsAddXlsx: (wsId: string, path: string) => ipcRenderer.invoke('ws:addXlsx', { wsId, path }),
    wsRename: (wsId: string, name: string) => ipcRenderer.invoke('ws:rename', { wsId, name }),
    wsSetIntelMode: (wsId: string, mode: 'global' | 'workspace') => ipcRenderer.invoke('ws:setIntelMode', { wsId, mode }),
    wsRemoveSource: (wsId: string, sourceId: number) => ipcRenderer.invoke('ws:removeSource', { wsId, sourceId }),
    wsRenameSource: (wsId: string, sourceId: number, name: string) =>
      ipcRenderer.invoke('ws:renameSource', { wsId, sourceId, name }),
    wsSetSourceGroup: (wsId: string, sourceId: number, group: string | null) =>
      ipcRenderer.invoke('ws:setSourceGroup', { wsId, sourceId, group }),
    wsAddDerivedColumns: (
      wsId: string,
      sourceId: number,
      jsonCol: string,
      fields: Array<{ path: string; displayName: string }>
    ) => ipcRenderer.invoke('ws:addDerivedColumns', { wsId, sourceId, jsonCol, fields }),
    wsBuildTimeline: (wsId: string, header: string[], rows: string[][]) =>
      ipcRenderer.invoke('ws:buildTimeline', { wsId, header, rows }),
    wsAgentSqlLog: (wsId: string, limit?: number) => ipcRenderer.invoke('ws:agentSqlLog', { wsId, limit }),
    wsGetDir: () => ipcRenderer.invoke('ws:getDir'),
    wsSetDir: (dir: string) => ipcRenderer.invoke('ws:setDir', { dir }),
    wsPickDir: () => ipcRenderer.invoke('ws:pickDir'),
    // Evidence root — the only tree the AI agent may import from. Analyst-set; no agent-side setter.
    wsGetEvidenceRoot: () => ipcRenderer.invoke('ws:getEvidenceRoot'),
    wsSetEvidenceRoot: (dir: string | null) => ipcRenderer.invoke('ws:setEvidenceRoot', { dir }),
    wsPickEvidenceRoot: () => ipcRenderer.invoke('ws:pickEvidenceRoot'),
    wsTagList: (wsId: string, sourceId: number) => ipcRenderer.invoke('ws:tagList', { wsId, sourceId }),
    wsAiMarkList: (wsId: string, sourceId: number) => ipcRenderer.invoke('ws:aiMarkList', { wsId, sourceId }),
    wsAiMarkClear: (wsId: string, sourceId: number) => ipcRenderer.invoke('ws:aiMarkClear', { wsId, sourceId }),
    wsEventList: (wsId: string) => ipcRenderer.invoke('ws:eventList', { wsId }),
    wsEventDelete: (wsId: string, id: string) => ipcRenderer.invoke('ws:eventDelete', { wsId, id }),
    wsEventClear: (wsId: string) => ipcRenderer.invoke('ws:eventClear', { wsId }),
    wsEventUpdate: (wsId: string, id: string, fields: { label: string; description: string | null; technique: string | null; users: string[] }) =>
      ipcRenderer.invoke('ws:eventUpdate', { wsId, id, ...fields }),
    wsEvidenceDelete: (wsId: string, evidenceId: number) => ipcRenderer.invoke('ws:evidenceDelete', { wsId, evidenceId }),
    wsEventCreateFromRows: (payload: {
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
    }) => ipcRenderer.invoke('ws:eventCreateFromRows', payload),
    wsIocList: (wsId: string) => ipcRenderer.invoke('ws:iocList', { wsId }),
    wsIocEventLinks: (wsId: string) => ipcRenderer.invoke('ws:iocEventLinks', { wsId }),
    wsIocDelete: (wsId: string, id: string) => ipcRenderer.invoke('ws:iocDelete', { wsId, id }),
    wsIocClear: (wsId: string) => ipcRenderer.invoke('ws:iocClear', { wsId }),
    wsLeadList: (wsId: string) => ipcRenderer.invoke('ws:leadList', { wsId }),
    wsLeadDelete: (wsId: string, id: string) => ipcRenderer.invoke('ws:leadDelete', { wsId, id }),
    wsLeadClear: (wsId: string) => ipcRenderer.invoke('ws:leadClear', { wsId }),
    wsLeadPromote: (wsId: string, id: string) => ipcRenderer.invoke('ws:leadPromote', { wsId, id }),
    wsCaseReport: (wsId: string) => ipcRenderer.invoke('ws:caseReport', { wsId }),
    wsCaseReview: (wsId: string, kind: string, id: string, verdict: string, reason?: string | null) =>
      ipcRenderer.invoke('ws:caseReview', { wsId, kind, id, verdict, reason }),
    wsNegativeList: (wsId: string) => ipcRenderer.invoke('ws:negativeList', { wsId }),
    wsNegativeDelete: (wsId: string, id: string) => ipcRenderer.invoke('ws:negativeDelete', { wsId, id }),
    wsEntityList: (wsId: string) => ipcRenderer.invoke('ws:entityList', { wsId }),
    wsEntityUpsert: (wsId: string, patch: unknown) => ipcRenderer.invoke('ws:entityUpsert', { wsId, patch }),
    wsEntityDelete: (wsId: string, id: string) => ipcRenderer.invoke('ws:entityDelete', { wsId, id }),
    wsEntityAliasAdd: (wsId: string, id: string, alias: string) => ipcRenderer.invoke('ws:entityAliasAdd', { wsId, id, alias }),
    wsEntityLink: (wsId: string, kind: string, primary: string, other: string, same: boolean, reason?: string) =>
      ipcRenderer.invoke('ws:entityLink', { wsId, kind, primary, other, same, reason }),
    wsEntityAliasRemove: (wsId: string, id: string, alias: string) => ipcRenderer.invoke('ws:entityAliasRemove', { wsId, id, alias }),
    wsInvestigationGet: (wsId: string) => ipcRenderer.invoke('ws:investigationGet', { wsId }),
    wsInvestigationSetPlan: (wsId: string, plan: unknown[]) => ipcRenderer.invoke('ws:investigationSetPlan', { wsId, plan }),
    wsInvestigationSetNotes: (wsId: string, notes: string) => ipcRenderer.invoke('ws:investigationSetNotes', { wsId, notes }),
    wsTagSet: (wsId: string, sourceId: number, rids: number[], tag: string | null) =>
      ipcRenderer.invoke('ws:tagSet', { wsId, sourceId, rids, tag }),
    wsTagByFilter: (wsId: string, sourceId: number, filters: unknown, search: string | undefined, tag: string | null) =>
      ipcRenderer.invoke('ws:tagByFilter', { wsId, sourceId, filters, search, tag }),
    tagCounts: (tabId: string, filters?: unknown, search?: string) =>
      ipcRenderer.invoke('csv:tagCounts', { tabId, filters, search }),
    cancel: (tabId: string) => ipcRenderer.invoke('csv:cancel', { tabId }),
    query: (tabId: string, opts: unknown) => ipcRenderer.invoke('csv:query', { tabId, opts }),
    count: (tabId: string, reqId: number, filters?: unknown, search?: string) =>
      ipcRenderer.invoke('csv:count', { tabId, reqId, filters, search }),
    distinct: (tabId: string, col: string, filters?: unknown, limit?: number, reqId?: number) =>
      ipcRenderer.invoke('csv:distinct', { tabId, col, filters, limit, reqId }),
    distinctCancel: (tabId: string) => ipcRenderer.invoke('csv:distinctCancel', { tabId }),
    onDistinctProgress: (cb: (p: unknown) => void) => {
      const h = (_e: unknown, p: unknown): void => cb(p)
      ipcRenderer.on('csv:distinct-progress', h)
      return () => ipcRenderer.removeListener('csv:distinct-progress', h)
    },
    // Intel sweep: scan a source for an intel set → sightings (intel_hits), with scan progress + cancel.
    sweep: (
      tabId: string,
      reqId: number,
      entries: Array<{ value: string; kind: string }>,
      columns?: string[],
      mode?: 'replace' | 'add'
    ) => ipcRenderer.invoke('csv:sweep', { tabId, reqId, entries, columns, mode }),
    sweepCancel: (tabId: string) => ipcRenderer.invoke('csv:sweepCancel', { tabId }),
    onSweepProgress: (cb: (p: unknown) => void) => {
      const h = (_e: unknown, p: unknown): void => cb(p)
      ipcRenderer.on('csv:sweep-progress', h)
      return () => ipcRenderer.removeListener('csv:sweep-progress', h)
    },
    sightingList: (wsId: string, sourceId: number) => ipcRenderer.invoke('csv:sightingList', { wsId, sourceId }),
    sightingSummary: (wsId: string, sourceId: number) => ipcRenderer.invoke('csv:sightingSummary', { wsId, sourceId }),
    sightingsAll: (wsId: string) => ipcRenderer.invoke('csv:sightingsAll', { wsId }),
    findInFiles: (wsId: string, term: string, opts?: { group?: string | null; ridCap?: number }) =>
      ipcRenderer.invoke('csv:findInFiles', { wsId, term, group: opts?.group, ridCap: opts?.ridCap }),
    sightingClear: (wsId: string, sourceId: number, opts?: { indicator?: string; rid?: number }) =>
      ipcRenderer.invoke('csv:sightingClear', { wsId, sourceId, indicator: opts?.indicator, rid: opts?.rid }),
    longest: (tabId: string, col: string) => ipcRenderer.invoke('csv:longest', { tabId, col }),
    locate: (tabId: string, rid: number, filters: unknown, search: string | undefined) =>
      ipcRenderer.invoke('csv:locate', { tabId, rid, filters, search }),
    values: (tabId: string, col: string, filters?: unknown) =>
      ipcRenderer.invoke('csv:values', { tabId, col, filters }),
    stats: (tabId: string, col: string) => ipcRenderer.invoke('csv:stats', { tabId, col }),
    export: (tabId: string, defaultName: string | undefined, opts: unknown) =>
      ipcRenderer.invoke('csv:export', { tabId, defaultName, opts }),
    close: (tabId: string) => ipcRenderer.invoke('csv:close', { tabId }),
    // Subscribe to ingest progress; returns a disposer (contextBridge can't pass the listener back).
    onProgress: (cb: (p: unknown) => void) => {
      const h = (_e: unknown, p: unknown): void => cb(p)
      ipcRenderer.on('csv:progress', h)
      return () => ipcRenderer.removeListener('csv:progress', h)
    },
    // Subscribe to live match-count progress (Scale #2). Returns a disposer.
    onCountProgress: (cb: (p: unknown) => void) => {
      const h = (_e: unknown, p: unknown): void => cb(p)
      ipcRenderer.on('csv:count-progress', h)
      return () => ipcRenderer.removeListener('csv:count-progress', h)
    }
  },

  // Threat-intel / enrichment: bulk-look-up indicators against a provider (MaxMind, …). The
  // cache DB + providers live in the worker; results stream back over 'enrich:progress'.
  enrich: {
    providers: () => ipcRenderer.invoke('enrich:providers'),
    pickMmdb: () => ipcRenderer.invoke('enrich:pickMmdb'),
    // MaxMind "set it up for me": download GeoLite2 with the user's free key (key stored encrypted).
    maxmindSetup: (key: string | undefined, editions?: string[]) =>
      ipcRenderer.invoke('enrich:maxmindSetup', { key, editions }),
    // Provider keys. WRITE-ONLY by design: the renderer can set a key or ask whether one exists, and
    // there is deliberately no way to read one back — main stores it safeStorage-encrypted and injects
    // the plaintext into the worker per run. Never add a getter here.
    keySpecs: () => ipcRenderer.invoke('enrich:keySpecs'),
    keyStatus: () => ipcRenderer.invoke('enrich:keyStatus'),
    setProviderKey: (providerId: string, key: string) => ipcRenderer.invoke('enrich:setProviderKey', { providerId, key }),
    vtGetSettings: () => ipcRenderer.invoke('enrich:vtGetSettings'),
    onSetupProgress: (cb: (p: unknown) => void) => {
      const h = (_e: unknown, p: unknown): void => cb(p)
      ipcRenderer.on('enrich:setup-progress', h)
      return () => ipcRenderer.removeListener('enrich:setup-progress', h)
    },
    defaultDb: () => ipcRenderer.invoke('enrich:defaultDb'),
    openDb: () => ipcRenderer.invoke('enrich:openDb'),
    newDb: () => ipcRenderer.invoke('enrich:newDb'),
    bulk: (reqId: number, dbPath: string, providerId: string, items: Array<{ value: string; kind: string }>) =>
      ipcRenderer.invoke('enrich:bulk', { reqId, dbPath, providerId, items }),
    cancel: () => ipcRenderer.invoke('enrich:cancel'),
    cacheCount: (dbPath: string) => ipcRenderer.invoke('enrich:cacheCount', { dbPath }),
    cacheGet: (dbPath: string, indicators: string[]) => ipcRenderer.invoke('enrich:cacheGet', { dbPath, indicators }),
    cacheDump: (dbPath: string, limit?: number) => ipcRenderer.invoke('enrich:cacheDump', { dbPath, limit }),
    cacheDelete: (dbPath: string, indicators: string[]) => ipcRenderer.invoke('enrich:cacheDelete', { dbPath, indicators }),
    // Subscribe to bulk-lookup progress; returns a disposer (contextBridge can't pass the listener back).
    onProgress: (cb: (p: unknown) => void) => {
      const h = (_e: unknown, p: unknown): void => cb(p)
      ipcRenderer.on('enrich:progress', h)
      return () => ipcRenderer.removeListener('enrich:progress', h)
    },
    // Open a URL in the default browser (e.g. "View on VirusTotal").
    openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', { url })
  },

  // Terminal-driven MCP surface: the app hosts a localhost MCP server so the analyst's own Claude
  // Code can drive the open workspace. The renderer publishes which workspace is focused, sets up the
  // working folder, and refreshes the review panels when a terminal tool mutates the workspace.
  mcp: {
    status: () => ipcRenderer.invoke('mcp:status'),
    // Tell main which workspace the terminal should drive (the active tab). Fire-and-forget.
    setActiveWorkspace: (ws: unknown) => ipcRenderer.send('mcp:setActiveWorkspace', ws),
    defaultFolder: () => ipcRenderer.invoke('mcp:defaultFolder'),
    pickFolder: () => ipcRenderer.invoke('mcp:pickFolder'),
    setupFolder: (dir?: string) => ipcRenderer.invoke('mcp:setupFolder', dir),
    openFolder: (dir: string) => ipcRenderer.invoke('mcp:openFolder', dir),
    // Fires when a terminal tool changed workspace state — the panels reload. Returns a disposer.
    onMutated: (cb: (p: { wsId?: string; tool: string }) => void) => {
      const h = (_e: unknown, p: unknown): void => cb(p as { wsId?: string; tool: string })
      ipcRenderer.on('ws:mutated', h)
      return () => ipcRenderer.removeListener('ws:mutated', h)
    },
    // The agent created/opened a case and wants it on screen. The renderer opens it and republishes
    // setActiveWorkspace, which is what releases the agent's waiting tool call. Returns a disposer.
    onOpenRequest: (cb: (p: { wsId: string; dbPath: string; name: string }) => void) => {
      const h = (_e: unknown, p: unknown): void => cb(p as { wsId: string; dbPath: string; name: string })
      ipcRenderer.on('ws:open-request', h)
      return () => ipcRenderer.removeListener('ws:open-request', h)
    }
  },

  // Pop-out windows: open a feature (Constellation / Timeline / Case Report) in its own window. The
  // payload travels in the window's URL hash; a popout relays grid actions back to the main window
  // (pivot, build-timeline-source, apply-group, refresh) since it doesn't own the grid/docs itself.
  popout: {
    open: (kind: string, payload: unknown) => ipcRenderer.invoke('popout:open', { kind, ...(payload as object) }),
    // From a popout: send an action to the main window (it owns the grid + doc state).
    relay: (msg: unknown) => ipcRenderer.send('popout:relay', msg),
    // In the main window: receive a popout's relayed action. Returns a disposer.
    onRelay: (cb: (p: unknown) => void) => {
      const h = (_e: unknown, p: unknown): void => cb(p)
      ipcRenderer.on('popout:relay', h)
      return () => ipcRenderer.removeListener('popout:relay', h)
    }
  },

  // Watchlists: the analyst's curated context lists (global, app-wide), edited in the Watchlists
  // drawer and matched by the 'watchlist' enrichment provider.
  watchlist: {
    list: () => ipcRenderer.invoke('watchlist:list'),
    entries: (id: number) => ipcRenderer.invoke('watchlist:entries', { id }),
    create: (name: string, kind: string, color?: string | null) =>
      ipcRenderer.invoke('watchlist:create', { name, kind, color }),
    rename: (id: number, name: string) => ipcRenderer.invoke('watchlist:rename', { id, name }),
    remove: (id: number) => ipcRenderer.invoke('watchlist:delete', { id }),
    replace: (id: number, text: string) => ipcRenderer.invoke('watchlist:replace', { id, text })
  }
}

contextBridge.exposeInMainWorld('api', api)
