// Shared types for the AI agent surface (Claude Code runner ↔ tools ↔ ipc).

/** A grounding tool the model may call. `parameters` is a JSON Schema object describing the args. */
export interface AiTool {
  name: string
  description: string
  parameters: object
}

/** A tool call the model requested. */
export interface AiToolCall {
  id: string
  name: string
  args: unknown
}

/** The single internal message format (user/assistant history sent from the renderer):
 *  - system/user carry plain text.
 *  - assistant may carry text and/or tool calls.
 *  - tool carries one tool's result, tied back to the call by toolCallId. */
export type AiMsg =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content?: string; toolCalls?: AiToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string }

export interface WsColumn {
  /** Positional SQL id (c0..cN) — what filters must reference. */
  name: string
  /** Human display header. */
  original: string
  /** Detected time kind, if any ('iso' | 'epoch_s' | 'epoch_ms'). */
  time?: string
}

/** The active-workspace context the renderer sends with each chat turn. The agent's grid tools key
 *  off this (tabId = `${wsId}:${sourceId}`); the schema lets the model plan queries against real
 *  columns without ever ingesting rows. */
/** One source (imported artifact/CSV) in the active workspace. */
export interface WsSource {
  sourceId: number
  /** The worker tab key (`${wsId}:${sourceId}`), computed by the renderer. */
  tabId: string
  name: string
  columns: WsColumn[]
  rowCount: number
  /** Analyst-assigned grouping label (the host/system/origin the artifact came from); null = ungrouped. */
  group?: string | null
  /** True for a DERIVED source (e.g. the materialized Timeline) — built FROM the investigation, not an
   *  input artifact to triage. Excluded from coverage so the agent isn't nudged to "investigate" it. */
  derived?: boolean
}

/** The active workspace, with EVERY source — so the agent can investigate across a whole triage
 *  package (KAPE + Hayabusa), not just the one source on screen. */
export interface WsCtx {
  hasWorkspace: boolean
  wsId?: string
  workspaceName?: string
  /** The source currently on screen — the default target when a tool omits `source`. */
  activeSourceId?: number | null
  /** All imported sources/artifacts in this workspace. */
  sources: WsSource[]
  /** Intel DB the cache-read tool queries (workspace's own, or the global default). */
  intelDbPath?: string
}

/** A state-changing action the assistant proposes; the user approves/rejects before it runs. */
export interface PendingAction {
  kind: 'tag' | 'group'
  summary: string
  detail?: string
  tag?: string
  count?: number
  /** For kind 'group': the source being (re)grouped and the proposed label (null = ungroup). Lets the
   *  renderer mirror the change into its doc state on approval. */
  sourceId?: number
  group?: string | null
}

/** Dependencies injected into tool execution — notably the human-in-the-loop approval gate. */
export interface ToolDeps {
  /** Ask the user to approve a state-changing action; resolves true if approved. */
  requestApproval?: (action: PendingAction) => Promise<boolean>
}

/** Per-run triage-coverage accumulator. The engine/agent-runner owns one per run, threads it into
 *  runTool so data-reading tools record which sources they examined (and review_coverage reads it back),
 *  then uses it to nudge the model toward any UNTOUCHED source before it concludes. Source of truth is
 *  the live data — this only tracks what the agent has actually looked at this run. */
export interface CoverageTracker {
  /** sourceIds examined with a data-reading tool this run (describe_workspace alone does NOT count). */
  examined: Set<number>
  /** How many events the agent has concluded this run — a signal that it's triaging (not just chatting). */
  recordedEvents: number
}

/** Events the engine streams to the renderer over the single `ai:event` channel. */
export type AgentEvent =
  | { type: 'token'; delta: string }
  | { type: 'tool'; phase: 'start' | 'done' | 'error'; id: string; name: string; args?: unknown; card?: string; result?: unknown; message?: string }
  | { type: 'action'; actionId: string; kind: string; summary: string; detail?: string; tag?: string; count?: number; sourceId?: number; group?: string | null }
  /** The model this run resolved to, from the SDK's init message — the only reliable way to know
   *  what's actually serving the run, since we usually send no model and let Claude Code decide. */
  | { type: 'model'; model: string }
  | { type: 'done'; truncated?: boolean }
  | { type: 'error'; message?: string }

export interface ChatRequest {
  reqId: number
  /** User/assistant turn history from the renderer (no system prompt — the engine prepends it). */
  messages: AiMsg[]
  wsCtx: WsCtx
  providerId?: string
  model?: string
}
