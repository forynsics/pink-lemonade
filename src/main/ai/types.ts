// Shared types for the AI agent surface (Claude Code runner ↔ tools ↔ ipc).

/** A grounding tool the model may call. `parameters` is a JSON Schema object describing the args. */
export interface AiTool {
  name: string
  description: string
  parameters: object
}


export interface WsColumn {
  /** Positional SQL id (c0..cN) — what filters must reference. */
  name: string
  /** Human display header. */
  original: string
  /** Detected time kind, if any ('iso' | 'epoch_s' | 'epoch_ms'). */
  time?: string
  /** True when values are numbers — ORDER BY must compare numerically (0, 1, 2, … not 0, 1, 10). */
  numeric?: boolean
}

/** The active-workspace context the renderer publishes for the MCP agent (setActiveWorkspace). The agent's grid tools key
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

/** A state-changing action the agent proposes; gated by the agent's own permission prompt. */
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
  /**
   * Show a workspace in the app and resolve once the renderer has it active — the handoff behind
   * create_case/use_workspace/import_evidence.
   *
   * This has to be awaited rather than fired-and-forgotten. Every other tool reads the workspace
   * context the RENDERER publishes, so a tool that returned as soon as the open was *requested*
   * would let the agent's next call land on the previous workspace. Resolves the context the
   * renderer actually published, so the caller can report what is really open.
   */
  showWorkspace?: (ws: { wsId: string; dbPath: string; name: string }) => Promise<WsCtx>
  /** Resolve once freshly imported sources are visible in the context the tools read (see bridge.ts). */
  syncSources?: (wsId: string, sourceIds: number[]) => Promise<WsCtx>
}

/** Per-run triage-coverage accumulator. The engine/agent-runner owns one per run, threads it into
 *  runTool so data-reading tools record which sources they examined (and review_coverage reads it back),
 *  then uses it to nudge the model toward any UNTOUCHED source before it concludes. Source of truth is
 *  the live data — this only tracks what the agent has actually looked at this run. */
export interface CoverageTracker {
  /** When this run began. Lets get_investigation_state tell work that PREDATES the session from
   *  work the agent just did — without it, calling update_plan once made the tool claim to be
   *  resuming an investigation it had started seconds earlier. */
  startedAt: number
  /** sourceIds examined with a data-reading tool this run (describe_workspace alone does NOT count). */
  examined: Set<number>
  /** sourceIds that RETURNED ROWS to a cross-source search this run. Weaker than `examined` — the
   *  agent saw some of this source's data without opening it — but not nothing, and reporting these
   *  as "never touched" sent it back to re-read sources it had already built findings from. */
  seenInSearch: Set<number>
  /** How many events the agent has concluded this run — a signal that it's triaging (not just chatting). */
  recordedEvents: number
}
