// The MCP surface that lets the analyst's OWN Claude Code (running in a terminal) drive the app.
//
// The app already carries a full investigation toolbox (TOOL_DEFS + runTool in ai/tools) that the
// retired in-app assistant used through an in-process SDK MCP server. This exposes that same toolbox
// over a real transport — a localhost HTTP MCP server — so an external `claude` can connect in and
// operate the workspace the analyst has open, the same way the in-app assistant did. Because the
// tools write to the workspace DB via dbClient and the review panels read those tables, the
// Constellation/Timeline/IOC/Investigation panels update live as the terminal works.
//
// Trust boundary: bound to 127.0.0.1 only, behind a bearer token. State-changing tools are gated by
// Claude Code's own permission prompt (declared via _meta requiresUserInteraction), so the token is
// about keeping other local processes out, not about the analyst's own approvals.

import http from 'node:http'
import { randomUUID, randomBytes } from 'node:crypto'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import * as dbw from '../../csv/dbClient'
import { newCoverage } from '../coverage'
import { runTool, TOOL_DEFS } from '../tools'
import type { CoverageTracker, WsCtx } from '../types'

const MCP_PATH = '/mcp'
// Fixed port: the analyst's .mcp.json pins this URL, so the port must be STABLE across restarts.
// We never drift to a different port (that would silently invalidate .mcp.json) — instead we retry the
// SAME port past a lingering socket from a just-closed instance (common on Windows after a restart).
const PORT = 8765
const BIND_RETRIES = 15
const BIND_RETRY_MS = 300

// Tools that change workspace state — a completed call broadcasts so the review panels reload.
// NOTE the lifecycle tools (create_case / use_workspace / import_evidence) are deliberately ABSENT.
// They drive the renderer themselves — showWorkspace/syncSources push the refresh and then WAIT for
// the renderer to confirm — so broadcasting again here fires a SECOND reopen after the tool has
// already returned. Reopening closes and reopens the workspace's SQLite connection, so that stray
// refresh lands underneath whatever the agent does next: back-to-back imports failed with "The
// database connection is not open" until this list stopped double-firing.
const WRITE_TOOLS = new Set([
  'tag_rows', 'set_source_group', 'mark_rows', 'record_event', 'update_event', 'record_ioc', 'record_lead', 'update_lead', 'record_entity', 'link_entities', 'record_negative', 'verify_negative', 'update_plan', 'save_progress'
])
// Tools whose effect is the analyst's call — Claude Code prompts in the terminal on every invocation,
// even when the server is allow-listed. This is the human-in-the-loop gate in terminal-driven mode.
// import_evidence is here because pulling files off disk into a case is the consequential step;
// create_case is NOT — scaffolding an empty case is cheap and reversible, and gating it would
// interrupt the analyst before any evidence is even in play. Note import_evidence takes a LIST of
// paths precisely so a 60-file triage package costs ONE prompt rather than sixty.
const INTERACTIVE_TOOLS = new Set(['tag_rows', 'set_source_group', 'import_evidence'])

/** Wiring the app injects: how to reach the workspace the analyst has open, and a hook fired after a
 *  state-changing tool so the renderer can refresh the review panels. */
export interface McpHooks {
  getActiveWs: () => WsCtx
  /** Open a workspace in the app, resolving once the renderer reports it active (see bridge.ts). */
  showWorkspace: (ws: { wsId: string; dbPath: string; name: string }) => Promise<WsCtx>
  /** Resolve once freshly imported sources are visible in the renderer's published context. */
  syncSources: (wsId: string, sourceIds: number[]) => Promise<WsCtx>
  onToolMutation: (toolName: string, wsId?: string) => void
}

export interface McpStatus {
  running: boolean
  port: number | null
  /** The bearer token clients must present — used to write the analyst's .mcp.json. */
  token: string | null
  url: string | null
  /** Set when the server could not start (e.g. the port is held by another program). */
  error?: string
}

const EMPTY_WS: WsCtx = { hasWorkspace: false, sources: [] }

let httpServer: http.Server | null = null
let boundPort: number | null = null
let token: string | null = null
let lastError: string | null = null
let hooks: McpHooks = {
  getActiveWs: () => EMPTY_WS,
  showWorkspace: () => Promise.reject(new Error('The app is not ready to open a workspace yet.')),
  syncSources: () => Promise.reject(new Error('The app is not ready yet.')),
  onToolMutation: () => {}
}

// One coverage tracker for the connection's lifetime — review_coverage reads it to report which
// sources the terminal has examined. Over-counting is harmless; it never under-reports untouched work.
let coverage: CoverageTracker = newCoverage()

/** Load the persisted bearer token, generating (and saving) one the first time. Kept stable across
 *  launches so the analyst's .mcp.json doesn't need rewriting each time. */
async function loadToken(): Promise<string> {
  const cfg = await dbw.call<Record<string, unknown>>('getAiConfig')
  const existing = typeof cfg.mcpToken === 'string' && cfg.mcpToken ? cfg.mcpToken : null
  if (existing) return existing
  const fresh = randomBytes(24).toString('hex')
  await dbw.call('setAiConfig', { mcpToken: fresh })
  return fresh
}

/** Build a low-level MCP server exposing the app's toolbox. A fresh one is connected per client
 *  session; the tools themselves are global (they reach the DB worker via dbClient). */
function buildServer(): Server {
  const server = new Server({ name: 'pinklemonade', version: '1.0.0' }, { capabilities: { tools: {} } })

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFS.map((def) => ({
      name: def.name,
      description: def.description,
      inputSchema: def.parameters as { type: 'object' },
      ...(INTERACTIVE_TOOLS.has(def.name) ? { _meta: { 'anthropic/requiresUserInteraction': true } } : {})
    }))
  }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name
    const args = (req.params.arguments ?? {}) as unknown
    const ws = hooks.getActiveWs()
    try {
      // The gate is upstream (requiresUserInteraction → Claude Code prompt); by the time a call
      // reaches here the analyst has allowed it, so approval inside runTool is a no-op.
      const { result } = await runTool(
        name,
        args,
        ws,
        { requestApproval: async () => true, showWorkspace: hooks.showWorkspace, syncSources: hooks.syncSources },
        coverage
      )
      // The lifecycle tools change which workspace is open, so the panels must reload against the
      // workspace that is active AFTER the call, not the (possibly stale) one captured before it.
      if (WRITE_TOOLS.has(name)) hooks.onToolMutation(name, hooks.getActiveWs().wsId ?? ws.wsId)
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true }
    }
  })

  return server
}

/** Read a request body as a parsed JSON value (StreamableHTTP wants the pre-parsed POST body). */
function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve(undefined)
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(text)
}

// Active StreamableHTTP transports by session id — a reconnecting client (Claude Code retries with
// backoff) re-initializes and gets a new session; closed sessions are pruned.
const transports = new Map<string, StreamableHTTPServerTransport>()

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = (req.url ?? '').split('?')[0]
  if (url !== MCP_PATH) {
    sendJson(res, 404, { error: 'not found' })
    return
  }
  // Bearer auth on every request. Loopback-only bind is the first line; the token keeps other local
  // processes from driving the app.
  const auth = req.headers['authorization']
  if (!token || auth !== `Bearer ${token}`) {
    sendJson(res, 401, { error: 'unauthorized' })
    return
  }

  const sessionId = req.headers['mcp-session-id']
  const sid = Array.isArray(sessionId) ? sessionId[0] : sessionId

  try {
    if (req.method === 'POST') {
      const body = await readBody(req)
      let transport: StreamableHTTPServerTransport | undefined = sid ? transports.get(sid) : undefined
      if (!transport) {
        if (sid) {
          // A session id we don't recognize — the app (and its server) restarted, or the session
          // expired. Per the Streamable HTTP spec, 404 tells the client to start a fresh session by
          // re-initializing, so Claude Code recovers AUTOMATICALLY after the app reopens instead of
          // getting stuck on a dead session. (Returning 400 here was the bug that forced a manual reconnect.)
          sendJson(res, 404, { jsonrpc: '2.0', error: { code: -32001, message: 'Session not found — start a new session by re-initializing.' }, id: null })
          return
        }
        if (!isInitializeRequest(body)) {
          sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32000, message: 'Send an initialize request first.' }, id: null })
          return
        }
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports.set(id, transport as StreamableHTTPServerTransport)
          }
        })
        transport.onclose = () => {
          if (transport && transport.sessionId) transports.delete(transport.sessionId)
        }
        await buildServer().connect(transport)
      }
      await transport.handleRequest(req, res, body)
      return
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      const transport = sid ? transports.get(sid) : undefined
      if (!transport) {
        // Unknown session (server restarted / expired) → 404 so the client re-initializes cleanly.
        sendJson(res, 404, { jsonrpc: '2.0', error: { code: -32001, message: 'Session not found — start a new session by re-initializing.' }, id: null })
        return
      }
      await transport.handleRequest(req, res)
      return
    }

    sendJson(res, 405, { error: 'method not allowed' })
  } catch (e) {
    if (!res.headersSent) sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) })
  }
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Try to bind `port` on 127.0.0.1 once. */
function bindOnce(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      server.removeListener('listening', onListening)
      reject(err)
    }
    const onListening = (): void => {
      server.removeListener('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '127.0.0.1')
  })
}

/** Bind the FIXED port, retrying the SAME port past a lingering socket from a just-closed instance.
 *  We never move to a different port — the analyst's .mcp.json pins this one. */
async function listenFixed(server: http.Server): Promise<void> {
  for (let attempt = 0; attempt < BIND_RETRIES; attempt++) {
    try {
      await bindOnce(server, PORT)
      return
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      if (err.code === 'EADDRINUSE' && attempt < BIND_RETRIES - 1) {
        await delay(BIND_RETRY_MS)
        continue
      }
      throw err
    }
  }
}

/** Start the MCP server (idempotent). Call once the DB worker is up. */
export async function startMcpServer(injected: McpHooks): Promise<McpStatus> {
  hooks = injected
  if (httpServer) return getMcpStatus()

  token = await loadToken()
  const server = http.createServer((req, res) => void handle(req, res))
  try {
    await listenFixed(server)
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    lastError =
      err.code === 'EADDRINUSE'
        ? `Port ${PORT} is in use by another program (or a second pink-lemonade window). Close it and reopen this app.`
        : err.message || String(err)
    try {
      server.close()
    } catch {
      /* ignore */
    }
    return getMcpStatus()
  }
  httpServer = server
  boundPort = PORT
  lastError = null
  return getMcpStatus()
}

export function getMcpStatus(): McpStatus {
  const running = !!httpServer && boundPort !== null
  return {
    running,
    port: running ? boundPort : PORT,
    token,
    url: running ? `http://127.0.0.1:${boundPort}${MCP_PATH}` : null,
    ...(lastError ? { error: lastError } : {})
  }
}

/** Reset the coverage tracker — called when the driven workspace changes. */
export function resetMcpCoverage(): void {
  coverage = newCoverage()
}

export async function stopMcpServer(): Promise<void> {
  for (const t of transports.values()) {
    try {
      await t.close()
    } catch {
      /* ignore */
    }
  }
  transports.clear()
  if (httpServer) {
    await new Promise<void>((resolve) => (httpServer as http.Server).close(() => resolve()))
    httpServer = null
    boundPort = null
  }
}
