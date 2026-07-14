// Claude Code provider — a keyless backend that rides the user's existing Claude Code login
// (their Claude subscription) instead of an API key. Unlike the HTTP providers, the Claude Agent
// SDK *owns the agent loop* and executes tools itself, so this is a standalone "agent runner" (not
// an AiProvider.stream): it registers OUR grounding tools as an in-process MCP server, disables all
// built-in file/bash/web tools, injects our system prompt, and maps the SDK's message stream to the
// same AgentEvents the panel already consumes. The grounding tools (runTool) are shared with the
// HTTP loop — only the orchestration differs.
//
// The SDK is ESM-only and our main bundle is CJS, so it (and a matching ESM zod) is loaded lazily
// via dynamic import: users who never pick this provider don't pay for it, and a missing/broken
// install degrades to a clear in-panel error rather than a startup crash.

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { coverageNudge, newCoverage } from './coverage'
import { buildSystemPrompt } from './prompt'
import { loadResumeBlock, persistCoverage, seedCoverage } from './resume'
import { runTool, TOOL_DEFS } from './tools'
import type { AgentEvent, ToolDeps, WsCtx } from './types'

const MAX_TURNS = 32
const MCP_NAME = 'pinklemonade'

// We deliberately do NOT bundle Anthropic's claude.exe — the assistant runs on the user's OWN installed
// Claude Code (their subscription). Resolve that binary so the SDK spawns it (pathToClaudeCodeExecutable)
// instead of a shipped copy. Prefer a real .exe over a .cmd shim (the SDK spawns it without a shell).
let cachedClaudePath: string | null = null
export function resolveClaudeExecutable(): string | null {
  if (cachedClaudePath) return cachedClaudePath
  cachedClaudePath = findClaudeExecutable()
  return cachedClaudePath
}
function findClaudeExecutable(): string | null {
  const override = process.env.PINK_CLAUDE_PATH?.trim()
  if (override && existsSync(override)) return override

  const isWin = process.platform === 'win32'
  // A NATIVE binary is required: the SDK spawns it directly (no shell), so a Windows .cmd/.ps1 shim
  // fails with `spawn EINVAL`. On Windows an npm install ships the real claude.exe under the bin dir's
  // sibling node_modules, with a .cmd shim on PATH — follow the shim to that exe.
  const nativeFor = (hit: string): string | null => {
    if (!isWin || /\.exe$/i.test(hit)) return existsSync(hit) ? hit : null
    const nested = join(dirname(hit), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
    return existsSync(nested) ? nested : null
  }

  // 1) Resolve `claude` on PATH, mapping any shim to its native exe.
  try {
    const out = execFileSync(isWin ? 'where' : 'which', ['claude'], { encoding: 'utf8', timeout: 4000 })
    for (const hit of out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
      const p = nativeFor(hit)
      if (p) return p
    }
  } catch {
    /* not on PATH — fall through to known install locations */
  }

  // 2) Known install locations (the native installer's ~/.local/bin, then a Programs dir).
  const home = homedir()
  const candidates = isWin
    ? [
        join(home, '.local', 'bin', 'claude.exe'),
        join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Programs', 'claude', 'claude.exe')
      ]
    : [join(home, '.local', 'bin', 'claude'), '/usr/local/bin/claude', '/opt/homebrew/bin/claude']
  return candidates.find((c) => existsSync(c)) ?? null
}

// Editable in the UI; the user's Claude login decides which of these their plan can serve.
export const CLAUDE_CODE_MODELS = ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-haiku-4-5']

export interface ClaudeCodeRunArgs {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  wsCtx: WsCtx
  providerNotes: string[]
  model?: string
  deps?: ToolDeps // injected tool dependencies (the human-in-the-loop approval gate)
}

export function claudeCodeStatus(): { ready: boolean; detail: string } {
  // We can tell if Claude Code is installed; login/reachability is only known at run time (the CLI
  // resolves auth from ~/.claude).
  if (!resolveClaudeExecutable()) return { ready: false, detail: 'Claude Code not found — install it, then run `claude` to sign in' }
  return { ready: true, detail: 'Uses your Claude Code login' }
}

/** Pull a text delta out of a partial-assistant stream event (Anthropic raw stream shape). */
export function textDeltaFromStreamEvent(event: unknown): string | null {
  const e = event as { type?: string; delta?: { type?: string; text?: string } }
  if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta' && typeof e.delta.text === 'string') return e.delta.text
  return null
}

/** Flatten chat history into a single prompt (the SDK starts a fresh session per call). */
export function buildPrompt(messages: Array<{ role: 'user' | 'assistant'; content: string }>): string {
  if (messages.length <= 1) return messages[0]?.content ?? ''
  const prior = messages
    .slice(0, -1)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n\n')
  return `Conversation so far:\n${prior}\n\nUser: ${messages[messages.length - 1]?.content ?? ''}`
}

function classifyError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  if (/login|auth|credential|unauthor|api key/i.test(m)) {
    return 'Claude Code is not logged in. Open a terminal and run `claude` to sign in with your Claude subscription.'
  }
  return `Claude Code error: ${m}`
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySdk = any

export async function runClaudeCodeAgent(args: ClaudeCodeRunArgs, emit: (ev: AgentEvent) => void, signal: AbortSignal): Promise<void> {
  let sdk: AnySdk
  let z: AnySdk
  try {
    sdk = await import('@anthropic-ai/claude-agent-sdk')
    const zmod: AnySdk = await import('zod')
    z = zmod.z ?? zmod.default ?? zmod
  } catch (e) {
    emit({ type: 'error', message: `Claude Code SDK is unavailable: ${e instanceof Error ? e.message : String(e)}` })
    return
  }
  const { query, tool, createSdkMcpServer } = sdk

  // Spawn the user's OWN installed Claude Code (their subscription) — we don't ship a copy.
  const claudePath = resolveClaudeExecutable()
  if (!claudePath) {
    emit({
      type: 'error',
      message:
        'Claude Code isn’t installed (or isn’t on PATH). Install it from claude.com/claude-code and run `claude` once to sign in — pink-lemonade runs on your own Claude subscription and does not bundle it.'
    })
    return
  }

  // Zod input shapes mirroring TOOL_DEFS by value (the SDK's tool() requires zod schemas).
  const source = z.string().optional()
  const shapes: Record<string, AnySdk> = {
    list_sources: {},
    describe_workspace: { source },
    find_rows: { value: z.string(), column: z.string().optional(), time_from: z.string().optional(), time_to: z.string().optional(), time_column: z.string().optional(), source },
    find_in_all_sources: { value: z.string(), groups: z.array(z.string()).optional(), sample: z.number().optional() },
    get_all_rows: { source },
    find_around_time: { timestamp: z.string(), within_sec: z.number().optional(), groups: z.array(z.string()).optional(), value: z.string().optional() },
    query_workspace: { filters: z.array(z.any()).optional(), search: z.string().optional(), limit: z.number().optional(), source },
    tag_rows: { tag: z.string(), value: z.string().optional(), column: z.string().optional(), filters: z.array(z.any()).optional(), search: z.string().optional(), source },
    set_source_group: { source, group: z.string() },
    mark_rows: { value: z.string().optional(), column: z.string().optional(), filters: z.array(z.any()).optional(), search: z.string().optional(), note: z.string().optional(), source },
    record_event: { label: z.string(), description: z.string().optional(), technique: z.string().optional(), users: z.array(z.string()).optional(), evidence: z.array(z.any()) },
    record_ioc: { value: z.string(), type: z.string(), context: z.string().optional() },
    list_events: {},
    list_iocs: {},
    review_coverage: { groups: z.array(z.string()).optional() },
    update_plan: { steps: z.array(z.any()) },
    save_progress: { notes: z.string() },
    get_distinct: { col: z.string(), limit: z.number().optional(), source },
    get_cached_intel: { indicators: z.array(z.string()) },
    classify_indicator: { value: z.string() }
  }

  // Triage-coverage tracking: shared across every tool call this run, so review_coverage and the
  // before-conclusion nudge below see which sources the agent actually examined.
  const coverage = newCoverage()

  let seq = 0
  const tools = TOOL_DEFS.map((def) =>
    tool(def.name, def.description, shapes[def.name] ?? {}, async (toolArgs: unknown) => {
      const id = `cc_${seq++}`
      emit({ type: 'tool', phase: 'start', id, name: def.name, args: toolArgs })
      try {
        const { result, card } = await runTool(def.name, toolArgs, args.wsCtx, args.deps, coverage)
        emit({ type: 'tool', phase: 'done', id, name: def.name, card, result })
        return { content: [{ type: 'text', text: JSON.stringify(result) }] }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        emit({ type: 'tool', phase: 'error', id, name: def.name, message })
        return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true }
      }
    })
  )

  const server = createSdkMcpServer({ name: MCP_NAME, version: '1.0.0', tools })

  // Seed coverage from disk + build the resume preamble (plan/notes/findings) before the system prompt,
  // so a resumed investigation continues instead of re-walking the case.
  await seedCoverage(args.wsCtx, coverage)
  const resumeBlock = await loadResumeBlock(args.wsCtx, coverage)
  const system = buildSystemPrompt(args.wsCtx, args.providerNotes, resumeBlock)

  // Bridge our cancel signal to the SDK's AbortController.
  const ac = new AbortController()
  if (signal.aborted) ac.abort()
  else signal.addEventListener('abort', () => ac.abort(), { once: true })

  const allowed = TOOL_DEFS.map((d) => `mcp__${MCP_NAME}__${d.name}`)

  const baseOptions = {
    abortController: ac,
    systemPrompt: system,
    mcpServers: { [MCP_NAME]: server },
    allowedTools: allowed, // our grounding tools auto-run without a permission prompt
    tools: [], // remove ALL built-in file/bash/web tools — only our tools exist
    // Safety net: deny anything that isn't one of ours (built-ins are already gone).
    canUseTool: async (toolName: string, input: Record<string, unknown>) =>
      toolName.startsWith(`mcp__${MCP_NAME}__`) ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Only pink-lemonade tools are permitted.' },
    includePartialMessages: true,
    maxTurns: MAX_TURNS,
    settingSources: [], // ignore project/global settings + CLAUDE.md; our system prompt governs
    pathToClaudeCodeExecutable: claudePath, // the user's installed Claude Code — never a bundled copy
    ...(args.model ? { model: args.model } : {})
  }

  // Run one SDK pass (a fresh prompt, or a `resume` of a prior session). Streams text tokens as they
  // arrive; returns the terminal outcome + the session id (so we can resume for the coverage nudge)
  // WITHOUT emitting the terminal event — the caller decides whether to nudge or finalize.
  type PassResult = { kind: 'done' | 'truncated' | 'error'; message?: string; sessionId?: string }
  const runPass = async (prompt: string, resume?: string): Promise<PassResult | null> => {
    const q: AnySdk = query({ prompt, options: { ...baseOptions, ...(resume ? { resume } : {}) } })
    for await (const msg of q) {
      if (signal.aborted) return null
      if (msg.type === 'stream_event') {
        const delta = textDeltaFromStreamEvent(msg.event)
        if (delta) emit({ type: 'token', delta })
      } else if (msg.type === 'result') {
        const sessionId = typeof msg.session_id === 'string' ? msg.session_id : undefined
        if (msg.subtype === 'success' && !msg.is_error) return { kind: 'done', sessionId }
        if (typeof msg.subtype === 'string' && msg.subtype.includes('max_turns')) return { kind: 'truncated', sessionId }
        return { kind: 'error', message: typeof msg.result === 'string' && msg.result ? msg.result : `Claude Code run ended: ${msg.subtype ?? 'error'}`, sessionId }
      }
    }
    return null
  }

  const finalize = (r: PassResult | null): void => {
    if (!r || r.kind === 'done') emit({ type: 'done' })
    else if (r.kind === 'truncated') emit({ type: 'done', truncated: true })
    else emit({ type: 'error', message: r.message })
  }

  try {
    const first = await runPass(buildPrompt(args.messages))
    if (signal.aborted) {
      emit({ type: 'done' })
      return
    }
    // One-time coverage nudge: if a triage finished with sources untouched, RESUME the session with
    // the reminder so the model can investigate or justify before the analyst sees a final answer.
    // Best-effort — if resume isn't supported / fails, bank the first pass's success.
    if (first?.kind === 'done' && first.sessionId) {
      const nudge = coverageNudge(args.wsCtx, coverage, false)
      if (nudge) {
        emit({ type: 'token', delta: '\n\n' }) // visual break before the follow-up answer
        let second: PassResult | null
        try {
          second = await runPass(nudge, first.sessionId)
        } catch {
          finalize({ kind: 'done' })
          return
        }
        if (signal.aborted) {
          emit({ type: 'done' })
          return
        }
        finalize(second ?? { kind: 'done' })
        return
      }
    }
    finalize(first)
  } catch (e) {
    if (signal.aborted) {
      emit({ type: 'done' })
      return
    }
    emit({ type: 'error', message: classifyError(e) })
  } finally {
    // Persist whatever sources were examined this run, so coverage survives the next boundary.
    await persistCoverage(args.wsCtx, coverage)
  }
}
