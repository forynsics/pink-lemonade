import { useCallback, useEffect, useRef, useState } from 'react'
import { Bot, Check, Download, ExternalLink, History, Loader2, Pencil, Plus, Send, Settings, Square, Trash2, Wrench, X } from 'lucide-react'
import type { AiConfig, AiEventPayload, AiWsCtx, ClaudeModelOption } from '../../state/enrichTypes'
import { loadAiPrefs, saveAiPrefs } from '../../state/ai'
import * as chat from '../../state/aiChat'

// The AI assistant — a right-side pull-out chat. The model is grounded: it operates the app through
// tools (workspace queries + intel-cache reads) rather than its own knowledge. The agent loop + model
// I/O run in main; this panel streams text tokens and tool-call cards over window.api.ai.onEvent, and
// includes the active workspace context with each turn so the model can query the real schema.

interface ToolCard {
  id: string
  name: string
  phase: 'start' | 'done' | 'error'
  card?: string
  message?: string
  /** The value the tool acted on (find/mark/tag by value) — makes the card a pivot into the grid. */
  value?: string
  /** The source the tool acted on — lets the pivot jump to the right grid (cross-source). */
  source?: string
}
interface ActionCard {
  actionId: string
  kind: string
  summary: string
  detail?: string
  tag?: string
  /** For kind 'group': the source + proposed label, so the panel can mirror it into doc state on approve. */
  sourceId?: number
  group?: string | null
  decided?: 'approved' | 'rejected'
}
interface Turn {
  role: 'user' | 'assistant'
  content: string
  tools?: ToolCard[]
  actions?: ActionCard[]
  error?: string
  truncated?: boolean
}

const MIN_W = 320
const MAX_W = 720

export function AiPanel({
  open,
  onClose,
  getWsCtx,
  scopeId,
  onTagsChanged,
  onFindingsChanged,
  onIocsChanged,
  onInvestigationChanged,
  onApplyGroup,
  onPivot,
  onPopOut,
  layout = 'panel'
}: {
  open: boolean
  onClose: () => void
  /** Reads the live active-workspace context at send time (so a tab switch is reflected). */
  getWsCtx: () => AiWsCtx
  /** Conversation scope: the active workspace id, or null for the General (no-workspace) bucket.
   *  Conversations are saved/loaded per scope; changing it loads that scope's latest chat. */
  scopeId: string | null
  /** Show a "pop out into its own window" button (panel mode only). */
  onPopOut?: () => void
  /** 'panel' = docked side panel (fixed width, drag-resize); 'window' = fill a detached popout. */
  layout?: 'panel' | 'window'
  /** Called after the assistant successfully tags/marks rows, so the active grid can reload markers. */
  onTagsChanged?: () => void
  /** Called after the assistant records an event, so the constellation can reload. */
  onFindingsChanged?: () => void
  /** Called after the assistant records an IOC, so the IOC catalog can reload. */
  onIocsChanged?: () => void
  /** Called after the assistant updates the plan / progress, so the Investigation panel can reload. */
  onInvestigationChanged?: () => void
  /** Called when the analyst APPROVES the assistant's group action, so the sidebar/doc state updates. */
  onApplyGroup?: (sourceId: number, group: string | null) => void
  /** Pivot to rows containing `value`; with `source`, jump to that source's grid (cross-source). */
  onPivot?: (value: string, source?: string) => void
}): JSX.Element | null {
  const [width, setWidth] = useState(() => loadAiPrefs().width)
  const [lastModel, setLastModel] = useState<string | null>(() => loadAiPrefs().lastModel ?? null)
  const [cfg, setCfg] = useState<AiConfig | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [turns, setTurns] = useState<Turn[]>([])
  const [convId, setConvId] = useState<string>(() => chat.newConversationId())
  const [history, setHistory] = useState<chat.ConvMeta[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)

  // Identity of the conversation the CURRENT `turns` belong to. Persistence targets THIS, not the
  // live `scopeId` prop — so a chat loaded under scope A is never saved into scope B mid-switch.
  const loadedRef = useRef<{ scope: chat.Scope; convId: string }>({ scope: scopeId, convId })
  // Set true right before a programmatic setTurns (load/new/delete) so the persist effect skips that
  // one change — loading or clearing a conversation must not re-save (and reorder) it.
  const skipSaveRef = useRef(true)

  const sanitizeTurns = (ts: Turn[]): Turn[] => ts.map((t) => (t.actions ? { ...t, actions: t.actions.filter((a) => a.decided) } : t))

  // Adopt a conversation into the view (its turns now belong to `scope`/`id`); the next persist is
  // skipped so merely loading doesn't rewrite it.
  const applyLoaded = useCallback((scope: chat.Scope, id: string, ts: Turn[]): void => {
    skipSaveRef.current = true
    loadedRef.current = { scope, convId: id }
    setConvId(id)
    setTurns(ts)
  }, [])

  // Load the active scope's most-recent conversation on open + whenever the workspace scope changes,
  // so each workspace (and the General bucket) shows its own latest chat. Older chats stay resumable
  // from the history list — nothing is overwritten.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      chat.migrateLegacyChat()
      const metas = await chat.listConversations(scopeId)
      if (cancelled) return
      setHistory(metas)
      if (metas.length > 0) {
        const c = await chat.getConversation(scopeId, metas[0].id)
        if (cancelled) return
        applyLoaded(scopeId, metas[0].id, (c?.turns as Turn[]) ?? [])
      } else {
        applyLoaded(scopeId, chat.newConversationId(), [])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [scopeId, applyLoaded])

  // The saved-conversation list is loaded on scope change, but that initial fetch can race the
  // workspace DB attaching (it returns [] before the ws is ready) and nothing refetches until an
  // action — which is why the list looked empty until you clicked "+". Refetch every time the
  // history dropdown opens so it always reflects what's on disk.
  useEffect(() => {
    if (!showHistory) return
    let cancelled = false
    void chat.listConversations(scopeId).then((m) => {
      if (!cancelled) setHistory(m)
    })
    return () => {
      cancelled = true
    }
  }, [showHistory, scopeId])

  // Persist the current conversation when a run settles (not mid-stream, to avoid per-token writes).
  // Always writes to the turns' OWNING scope/conv (loadedRef), so a tab switch can't cross-save.
  // Undecided action cards are dropped so they don't show dead Approve/Reject buttons on reload.
  useEffect(() => {
    if (skipSaveRef.current) {
      skipSaveRef.current = false
      return
    }
    if (busy || turns.length === 0) return
    const { scope, convId: cid } = loadedRef.current
    void chat.upsertConversation(scope, { id: cid, title: chat.deriveTitle(turns), turns: sanitizeTurns(turns) }).then(() => {
      void chat.listConversations(scope).then((m) => {
        if (loadedRef.current.scope === scope) setHistory(m)
      })
    })
  }, [turns, busy])

  const reqIdRef = useRef(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const getWsCtxRef = useRef(getWsCtx)
  getWsCtxRef.current = getWsCtx
  const onApplyGroupRef = useRef(onApplyGroup)
  onApplyGroupRef.current = onApplyGroup

  const refreshConfig = useCallback(async (): Promise<void> => {
    const c = await window.api.ai.getConfig()
    setCfg(c)
  }, [])

  useEffect(() => {
    if (open) void refreshConfig()
  }, [open, refreshConfig])

  // One persistent subscription; updates the streaming assistant turn for the active run only.
  useEffect(() => {
    const dispose = window.api.ai.onEvent((raw) => {
      const ev = raw as AiEventPayload
      if (ev.reqId !== reqIdRef.current) return
      // Not a turn update — it's session metadata, and the only place we learn which model is
      // actually serving this run. Remember it so Settings can report it even before the next run.
      if (ev.type === 'model') {
        setLastModel(ev.model)
        saveAiPrefs({ ...loadAiPrefs(), lastModel: ev.model })
        return
      }
      setTurns((prev) => {
        const next = [...prev]
        const last = next[next.length - 1]
        if (!last || last.role !== 'assistant') return prev
        if (ev.type === 'token') {
          next[next.length - 1] = { ...last, content: last.content + ev.delta }
        } else if (ev.type === 'tool') {
          const tools = [...(last.tools ?? [])]
          const i = tools.findIndex((t) => t.id === ev.id)
          const argVal = ev.args && typeof ev.args === 'object' ? (ev.args as { value?: unknown }).value : undefined
          const resSrc = ev.result && typeof ev.result === 'object' ? (ev.result as { source?: unknown }).source : undefined
          const argSrc = ev.args && typeof ev.args === 'object' ? (ev.args as { source?: unknown }).source : undefined
          const card: ToolCard = {
            id: ev.id,
            name: ev.name,
            phase: ev.phase,
            card: ev.card,
            message: ev.message,
            value: typeof argVal === 'string' ? argVal : undefined,
            source: typeof resSrc === 'string' ? resSrc : typeof argSrc === 'string' ? argSrc : undefined
          }
          if (i >= 0) tools[i] = { ...tools[i], ...card }
          else tools.push(card)
          next[next.length - 1] = { ...last, tools }
        } else if (ev.type === 'action') {
          const actions = [...(last.actions ?? []), { actionId: ev.actionId, kind: ev.kind, summary: ev.summary, detail: ev.detail, tag: ev.tag, sourceId: ev.sourceId, group: ev.group }]
          next[next.length - 1] = { ...last, actions }
        } else if (ev.type === 'error') {
          next[next.length - 1] = { ...last, error: ev.message ?? 'Request failed' }
        } else if (ev.type === 'done') {
          next[next.length - 1] = { ...last, truncated: ev.truncated }
        }
        return next
      })
      // A completed tag/mark/finding run means grid markers are stale — reload them; a recorded
      // finding also means the constellation is stale.
      if (ev.type === 'tool' && ev.phase === 'done') {
        if (ev.name === 'tag_rows' || ev.name === 'mark_rows' || ev.name === 'record_event') onTagsChanged?.()
        if (ev.name === 'record_event') onFindingsChanged?.()
        if (ev.name === 'record_ioc') onIocsChanged?.()
        if (ev.name === 'update_plan' || ev.name === 'save_progress') onInvestigationChanged?.()
      }
      if (ev.type === 'done' || ev.type === 'error') setBusy(false)
    })
    return dispose
  }, [onTagsChanged, onFindingsChanged, onIocsChanged, onInvestigationChanged])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [turns])

  // Claude Code needs no key; readiness is only truly known at run time (login), so "ready" just means
  // config has loaded. A not-signed-in state surfaces as a clear in-panel error on the first run.
  const ready = !!cfg

  async function send(explicit?: string): Promise<void> {
    const text = (explicit ?? input).trim()
    if (!text || busy) return
    if (!ready) {
      setShowSettings(true)
      return
    }
    const history = turns.filter((t) => t.role === 'user' || t.content).map((t) => ({ role: t.role, content: t.content }))
    const messages = [...history, { role: 'user' as const, content: text }]
    setTurns((prev) => [...prev, { role: 'user', content: text }, { role: 'assistant', content: '', tools: [] }])
    if (!explicit) setInput('')
    setBusy(true)
    const reqId = ++reqIdRef.current
    try {
      await window.api.ai.chat({ reqId, messages, wsCtx: getWsCtxRef.current() })
    } catch (e) {
      setTurns((prev) => {
        const next = [...prev]
        const last = next[next.length - 1]
        if (last && last.role === 'assistant') next[next.length - 1] = { ...last, error: e instanceof Error ? e.message : String(e) }
        return next
      })
      setBusy(false)
    }
  }

  // Resume after a batch hit the step limit: re-enter with full history (findings already persist in
  // the workspace db) and nudge the model to recover its recorded state before continuing.
  const CONTINUE_PROMPT = 'Continue the investigation from where you left off. First call list_events and list_iocs to recover what you have already recorded, then proceed.'
  function continueRun(): void {
    void send(CONTINUE_PROMPT)
  }

  function stop(): void {
    void window.api.ai.cancel(reqIdRef.current)
    reqIdRef.current = -1 // ignore any late events from the canceled run
    setBusy(false)
  }

  function refreshHistory(): void {
    void chat.listConversations(scopeId).then((m) => {
      if (loadedRef.current.scope === scopeId) setHistory(m)
    })
  }

  // Archive the current chat (already saved) and start a fresh one — never destroys the old one.
  function newChat(): void {
    if (busy) return
    applyLoaded(scopeId, chat.newConversationId(), [])
    setShowHistory(false)
    refreshHistory()
  }

  async function openConversation(id: string): Promise<void> {
    setShowHistory(false)
    if (busy || id === convId) return
    const c = await chat.getConversation(scopeId, id)
    applyLoaded(scopeId, id, (c?.turns as Turn[]) ?? [])
  }

  async function removeConversation(id: string): Promise<void> {
    await chat.deleteConversation(scopeId, id)
    const metas = await chat.listConversations(scopeId)
    setHistory(metas)
    if (id !== convId) return
    // Deleted the open chat — fall back to the next most-recent, or a fresh blank one.
    if (metas.length > 0) {
      const c = await chat.getConversation(scopeId, metas[0].id)
      applyLoaded(scopeId, metas[0].id, (c?.turns as Turn[]) ?? [])
    } else {
      applyLoaded(scopeId, chat.newConversationId(), [])
    }
  }

  function commitRename(id: string): void {
    const title = editText.trim()
    setEditingId(null)
    if (title) void chat.renameConversation(scopeId, id, title).then(refreshHistory)
  }

  async function exportChat(): Promise<void> {
    if (turns.length === 0) return
    await window.api.saveFile(transcriptToMarkdown(turns), 'pink-lemonade-investigation.md')
  }

  // Approve/reject a proposed action; sends the verdict back to the paused agent run. An approved
  // group action is mirrored into the workspace doc state so the sidebar (and the next turn's
  // list_sources, built from that state) reflect it without a reopen.
  const decideAction = useCallback(
    (action: ActionCard, approved: boolean): void => {
      void window.api.ai.actionResult(action.actionId, approved)
      if (approved && action.kind === 'group' && action.sourceId != null) onApplyGroupRef.current?.(action.sourceId, action.group ?? null)
      setTurns((prev) =>
        prev.map((t) =>
          t.actions ? { ...t, actions: t.actions.map((a) => (a.actionId === action.actionId ? { ...a, decided: approved ? 'approved' : 'rejected' } : a)) } : t
        )
      )
    },
    []
  )

  // Drag-to-resize (mirrors DistinctPanel): the handle on the panel's left edge widens leftward.
  const startResize = (e: React.MouseEvent): void => {
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    const onMove = (ev: MouseEvent): void => {
      const w = Math.min(MAX_W, Math.max(MIN_W, startW + (startX - ev.clientX)))
      setWidth(w)
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      saveAiPrefs({ ...loadAiPrefs(), width })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  if (!open) return null

  const isWindow = layout === 'window'

  return (
    <aside
      className={`ai-panel relative flex min-h-0 flex-col bg-citrus-card dark:bg-citrus-night-card ${
        isWindow ? 'h-full w-full' : 'shrink-0 border-l border-citrus-border dark:border-citrus-night-border'
      }`}
      style={isWindow ? undefined : { width }}
    >
      {/* Resize handle on the left edge — drag toward the content to widen (docked panel only). */}
      {!isWindow && (
        <div
          className="absolute left-0 top-0 z-10 h-full w-1 cursor-col-resize hover:bg-citrus-pink/40"
          onMouseDown={startResize}
          title="Drag to resize"
        />
      )}

        {/* Header */}
        <div className="flex items-center justify-between gap-2 border-b border-citrus-border px-4 py-3 dark:border-citrus-night-border">
          <div className="flex items-center gap-2 min-w-0">
            <Bot className="w-4 h-4 text-citrus-pink shrink-0" />
            <div className="min-w-0">
              <div className="text-sm font-bold text-citrus-dark dark:text-citrus-night-text">AI Assistant</div>
              <div className="text-[11px] text-citrus-muted dark:text-citrus-night-muted">
                Grounded in your data &amp; intel — uses the app&apos;s tools, not guesses.
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => setShowHistory((s) => !s)}
              title="Conversation history"
              className={`rounded p-1 transition-colors ${showHistory ? 'text-citrus-pink' : 'text-citrus-muted hover:text-citrus-pink dark:text-citrus-night-muted'}`}
            >
              <History className="w-4 h-4" />
            </button>
            <button
              onClick={() => void exportChat()}
              title="Export transcript"
              disabled={turns.length === 0}
              className="rounded p-1 text-citrus-muted hover:text-citrus-pink disabled:opacity-30 dark:text-citrus-night-muted"
            >
              <Download className="w-4 h-4" />
            </button>
            <button
              onClick={newChat}
              title="New chat"
              disabled={busy || turns.length === 0}
              className="rounded p-1 text-citrus-muted hover:text-citrus-pink disabled:opacity-30 dark:text-citrus-night-muted"
            >
              <Plus className="w-4 h-4" />
            </button>
            <button
              onClick={() => setShowSettings((s) => !s)}
              title="Settings"
              className={`rounded p-1 transition-colors ${showSettings ? 'text-citrus-pink' : 'text-citrus-muted hover:text-citrus-pink dark:text-citrus-night-muted'}`}
            >
              <Settings className="w-4 h-4" />
            </button>
            {onPopOut && (
              <button onClick={onPopOut} title="Pop out" className="rounded p-1 text-citrus-muted hover:text-citrus-pink dark:text-citrus-night-muted">
                <ExternalLink className="w-4 h-4" />
              </button>
            )}
            <button onClick={onClose} title={isWindow ? 'Close window' : 'Close'} className="rounded p-1 text-citrus-muted hover:text-citrus-pink dark:text-citrus-night-muted">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {showHistory && (
          <>
            <div className="absolute inset-0 z-20" onClick={() => { setShowHistory(false); setEditingId(null) }} />
            <div className="absolute right-2 top-14 z-30 flex max-h-[60%] w-[min(340px,90%)] flex-col overflow-hidden rounded-lg border border-citrus-border bg-citrus-card shadow-lg dark:border-citrus-night-border dark:bg-citrus-night-card">
              <div className="flex items-center justify-between px-3 py-2 border-b border-citrus-border/60 dark:border-citrus-night-border/60">
                <span className="text-[11px] font-bold uppercase tracking-wide text-citrus-muted dark:text-citrus-night-muted">
                  {scopeId ? 'Workspace chats' : 'General chats'}
                </span>
                <span className="text-[10px] text-citrus-muted dark:text-citrus-night-muted">{history.length}</span>
              </div>
              <div className="overflow-y-auto">
                {history.length === 0 ? (
                  <div className="px-3 py-4 text-center text-[12px] text-citrus-muted dark:text-citrus-night-muted">No saved conversations yet.</div>
                ) : (
                  history.map((c) => (
                    <div
                      key={c.id}
                      className={`group flex items-center gap-1 border-b border-citrus-border/30 px-2 py-1.5 last:border-0 dark:border-citrus-night-border/30 ${
                        c.id === convId ? 'bg-citrus-pink/10' : ''
                      }`}
                    >
                      {editingId === c.id ? (
                        <>
                          <input
                            autoFocus
                            value={editText}
                            onChange={(e) => setEditText(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') commitRename(c.id)
                              if (e.key === 'Escape') setEditingId(null)
                            }}
                            className="min-w-0 flex-1 rounded border border-citrus-border bg-citrus-bg px-1.5 py-0.5 text-[12px] text-citrus-dark outline-none focus:border-citrus-pink/60 dark:border-citrus-night-border dark:bg-citrus-night-bg dark:text-citrus-night-text"
                          />
                          <button onClick={() => commitRename(c.id)} title="Save name" className="shrink-0 rounded p-1 text-citrus-muted hover:text-citrus-pink">
                            <Check className="w-3.5 h-3.5" />
                          </button>
                        </>
                      ) : (
                        <>
                          <button onClick={() => void openConversation(c.id)} className="min-w-0 flex-1 text-left">
                            <div className="truncate text-[12px] text-citrus-dark dark:text-citrus-night-text">{c.title || 'Untitled chat'}</div>
                            <div className="text-[10px] text-citrus-muted dark:text-citrus-night-muted">
                              {relTime(c.updatedAt)} · {c.turnCount} msg{c.turnCount === 1 ? '' : 's'}
                              {c.id === convId ? ' · current' : ''}
                            </div>
                          </button>
                          <button
                            onClick={() => {
                              setEditingId(c.id)
                              setEditText(c.title)
                            }}
                            title="Rename"
                            className="shrink-0 rounded p-1 text-citrus-muted opacity-0 hover:text-citrus-pink group-hover:opacity-100"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => void removeConversation(c.id)}
                            title="Delete conversation"
                            className="shrink-0 rounded p-1 text-citrus-muted opacity-0 hover:text-red-500 group-hover:opacity-100"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          </>
        )}

        {showSettings && <SettingsPane cfg={cfg} lastModel={lastModel} onSaved={refreshConfig} />}

        {/* Conversation */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {turns.length === 0 && (
            <div className="text-[12px] text-citrus-muted dark:text-citrus-night-muted">
              Ask about the open workspace or your indicators:
              <ul className="mt-1.5 list-disc pl-4 space-y-1">
                <li>“What columns and event types are in this source?”</li>
                <li>“How many rows mention 8.8.8.8?”</li>
                <li>“What do we already know about these IPs?”</li>
              </ul>
            </div>
          )}
          {turns.map((t, i) => (
            <MessageBubble key={i} turn={t} onDecide={decideAction} onPivot={onPivot} onContinue={i === turns.length - 1 && !busy ? continueRun : undefined} />
          ))}
          {busy && (
            <div className="flex items-center gap-2 text-[11px] text-citrus-muted dark:text-citrus-night-muted">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> thinking…
            </div>
          )}
        </div>

        {/* Composer */}
        <div className="border-t border-citrus-border px-3 py-2.5 dark:border-citrus-night-border">
          <div className="flex items-end gap-2">
            <textarea
              className="ai-panel__input flex-1 resize-none rounded-lg border border-citrus-border bg-citrus-bg px-3 py-2 text-[13px] text-citrus-dark outline-none focus:border-citrus-pink/60 dark:border-citrus-night-border dark:bg-citrus-night-bg dark:text-citrus-night-text"
              rows={2}
              placeholder={ready ? 'Ask about your data…' : 'Configure a provider in settings first…'}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void send()
                }
              }}
            />
            {busy ? (
              <button onClick={stop} title="Stop" className="rounded-lg bg-citrus-sand p-2 text-citrus-dark hover:bg-citrus-sand/70 dark:bg-citrus-night-elev dark:text-citrus-night-text">
                <Square className="w-4 h-4" />
              </button>
            ) : (
              <button
                onClick={() => void send()}
                title="Send (Enter)"
                className="ai-panel__send rounded-lg bg-citrus-pink p-2 text-white hover:bg-citrus-pink-hover disabled:opacity-40"
                disabled={!input.trim()}
              >
                <Send className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
    </aside>
  )
}

/** Compact relative timestamp for the history list ("just now", "5m ago", "3d ago", then a date). */
function relTime(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d ago`
  return new Date(ts).toLocaleDateString()
}

/** Render the conversation as Markdown for export — tool calls and actions included as bullets. */
function transcriptToMarkdown(turns: Turn[]): string {
  const lines: string[] = ['# pink-lemonade — AI Assistant transcript', '']
  for (const t of turns) {
    if (t.role === 'user') {
      lines.push('## You', '', t.content, '')
      continue
    }
    lines.push('## Assistant', '')
    for (const tool of t.tools ?? []) lines.push(`- 🔧 ${tool.card ?? tool.message ?? tool.name}`)
    for (const a of t.actions ?? []) lines.push(`- ⚑ ${a.summary}${a.decided ? ` — ${a.decided}` : ''}`)
    if ((t.tools?.length ?? 0) > 0 || (t.actions?.length ?? 0) > 0) lines.push('')
    if (t.content) lines.push(t.content, '')
    if (t.error) lines.push(`> Error: ${t.error}`, '')
  }
  return lines.join('\n')
}

// Indicators worth making clickable in the assistant's prose: IPv4, hashes, known-extension file
// names, and domains. Clicking pivots the active grid to that value.
const PIVOT_RE =
  /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b|\b[a-fA-F0-9]{32,64}\b|\b[\w-]+(?:\.[\w-]+)*\.(?:exe|dll|msi|ps1|bat|cmd|vbs|js|jar|scr|sys|tmp|dat|lnk|zip|rar|7z|docx?|xlsx?|pdf)\b|\b(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}\b/g

/** Render text with detected indicators wrapped as clickable pivots into the grid. */
function renderWithPivots(text: string, onPivot?: (v: string) => void): React.ReactNode {
  if (!onPivot || !text) return text
  const out: React.ReactNode[] = []
  const re = new RegExp(PIVOT_RE)
  let last = 0
  let m: RegExpExecArray | null
  let k = 0
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const val = m[0]
    out.push(
      <span
        key={k++}
        onClick={() => onPivot(val)}
        title={`Find “${val}” in the grid`}
        className="cursor-pointer underline decoration-dotted decoration-citrus-pink/50 underline-offset-2 hover:text-citrus-pink hover:decoration-citrus-pink"
      >
        {val}
      </span>
    )
    last = m.index + val.length
    if (re.lastIndex === m.index) re.lastIndex++ // guard against any zero-length match
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

function MessageBubble({
  turn,
  onDecide,
  onContinue,
  onPivot
}: {
  turn: Turn
  onDecide: (action: ActionCard, approved: boolean) => void
  onContinue?: () => void
  onPivot?: (value: string, source?: string) => void
}): JSX.Element {
  if (turn.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-citrus-pink/10 px-3 py-2 text-[13px] text-citrus-dark whitespace-pre-wrap dark:bg-citrus-pink/15 dark:text-citrus-night-text">
          {turn.content}
        </div>
      </div>
    )
  }
  return (
    <div className="space-y-1.5">
      {(turn.tools ?? []).map((t) => {
        const pivotable = !!t.value && !!onPivot
        const Tag = pivotable ? 'button' : 'div'
        return (
          <Tag
            key={t.id}
            {...(pivotable ? { onClick: () => onPivot?.(t.value as string, t.source), title: t.source ? `Jump to “${t.value}” in ${t.source}` : `Find “${t.value}” in the grid` } : {})}
            className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] ${pivotable ? 'cursor-pointer hover:border-citrus-pink/50 hover:text-citrus-pink' : ''} ${
              t.phase === 'error'
                ? 'border-red-300 bg-red-50 text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300'
                : 'border-citrus-border bg-citrus-bg text-citrus-muted dark:border-citrus-night-border dark:bg-citrus-night-bg dark:text-citrus-night-muted'
            }`}
          >
            {t.phase === 'start' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wrench className="w-3 h-3" />}
            <span className="font-mono">{t.card ?? t.message ?? t.name}</span>
          </Tag>
        )
      })}
      {(turn.actions ?? []).map((a) => (
        <div
          key={a.actionId}
          className="rounded-lg border border-citrus-pink/40 bg-citrus-pink/5 px-3 py-2 text-[12px] dark:border-citrus-pink/30 dark:bg-citrus-pink/10"
        >
          <div className="font-semibold text-citrus-dark dark:text-citrus-night-text">Proposed action</div>
          <div className="mt-0.5 text-citrus-dark dark:text-citrus-night-text">{a.summary}</div>
          {a.detail && <div className="mt-0.5 text-[11px] text-citrus-muted dark:text-citrus-night-muted">{a.detail}</div>}
          {a.decided ? (
            <div className={`mt-1.5 text-[11px] font-semibold ${a.decided === 'approved' ? 'text-citrus-pink' : 'text-citrus-muted dark:text-citrus-night-muted'}`}>
              {a.decided === 'approved' ? '✓ Approved' : '✕ Rejected'}
            </div>
          ) : (
            <div className="mt-2 flex gap-2">
              <button
                onClick={() => onDecide(a, true)}
                className="rounded-md bg-citrus-pink px-2.5 py-1 text-[11px] font-bold text-white hover:bg-citrus-pink-hover"
              >
                Approve
              </button>
              <button
                onClick={() => onDecide(a, false)}
                className="rounded-md border border-citrus-border px-2.5 py-1 text-[11px] font-semibold text-citrus-muted hover:text-citrus-pink dark:border-citrus-night-border dark:text-citrus-night-muted"
              >
                Reject
              </button>
            </div>
          )}
        </div>
      ))}
      {turn.content && (
        <div className="text-[13px] leading-relaxed text-citrus-dark whitespace-pre-wrap dark:text-citrus-night-text">{renderWithPivots(turn.content, onPivot)}</div>
      )}
      {turn.error && (
        <div className="rounded-md border border-red-300 bg-red-50 px-2 py-1 text-[11px] text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
          {turn.error}
        </div>
      )}
      {turn.truncated && (
        <div className="flex items-center gap-2 rounded-md border border-citrus-border bg-citrus-sand/40 px-2 py-1.5 text-[11px] text-citrus-muted dark:border-citrus-night-border dark:bg-citrus-night-elev/50 dark:text-citrus-night-muted">
          <span className="flex-1">Paused at the step limit — findings saved.</span>
          {onContinue && (
            <button onClick={onContinue} className="shrink-0 rounded-md bg-citrus-pink px-2.5 py-1 text-[11px] font-bold text-white hover:bg-citrus-pink-hover">
              Continue
            </button>
          )}
        </div>
      )}
    </div>
  )
}

const CUSTOM = '__custom__' // sentinel select value; can't collide with a real model id

function SettingsPane({ cfg, lastModel, onSaved }: { cfg: AiConfig | null; lastModel: string | null; onSaved: () => Promise<void> }): JSX.Element {
  const [model, setModel] = useState(cfg?.model ?? '')
  const [models, setModels] = useState<ClaudeModelOption[]>([])
  const [custom, setCustom] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  // A saved model that isn't one of the presets (a pinned id like claude-sonnet-4-6) belongs in the
  // custom field — otherwise the select would silently misreport what's actually configured.
  useEffect(() => {
    const saved = cfg?.model ?? ''
    setModel(saved)
    setCustom(saved !== '' && models.length > 0 && !models.some((m) => m.id === saved))
  }, [cfg, models])

  useEffect(() => {
    void window.api.ai.listModels().then(setModels)
  }, [])

  async function saveSettings(): Promise<void> {
    const next = model.trim()
    await window.api.ai.setConfig({ model: next })
    setMsg('Saved.')
    await onSaved()
  }

  const hint = custom ? 'Pinned to this exact model.' : models.find((m) => m.id === model)?.hint

  return (
    <div className="border-b border-citrus-border bg-citrus-bg/60 px-4 py-3 space-y-2.5 dark:border-citrus-night-border dark:bg-citrus-night-bg/40">
      <div className="text-[11px] font-bold uppercase tracking-wide text-citrus-muted dark:text-citrus-night-muted">Claude</div>

      <div className="rounded-md border border-citrus-border bg-citrus-card px-2.5 py-2 text-[11px] text-citrus-muted dark:border-citrus-night-border dark:bg-citrus-night-card dark:text-citrus-night-muted">
        Runs on your <span className="font-mono">Claude Code</span> login — your Claude subscription, <strong>no API key</strong>. If a run fails, run <span className="font-mono">claude</span> in a terminal to sign in.
      </div>

      <div>
        <label className="text-[11px] text-citrus-muted dark:text-citrus-night-muted">Model</label>
        <select
          className="mt-0.5 w-full rounded-md border border-citrus-border bg-citrus-card px-2 py-1.5 text-[12px] text-citrus-dark dark:border-citrus-night-border dark:bg-citrus-night-card dark:text-citrus-night-text"
          value={custom ? CUSTOM : model}
          onChange={(e) => {
            const v = e.target.value
            if (v === CUSTOM) {
              setCustom(true)
              setModel('')
            } else {
              setCustom(false)
              setModel(v)
            }
          }}
        >
          {models.map((m) => (
            <option key={m.id || 'default'} value={m.id}>
              {m.label}
            </option>
          ))}
          <option value={CUSTOM}>Custom…</option>
        </select>
        {custom && (
          <input
            className="mt-1.5 w-full rounded-md border border-citrus-border bg-citrus-card px-2 py-1.5 text-[12px] font-mono text-citrus-dark dark:border-citrus-night-border dark:bg-citrus-night-card dark:text-citrus-night-text"
            placeholder="e.g. claude-opus-4-8"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
        )}
        {hint && <div className="mt-1 text-[11px] text-citrus-muted dark:text-citrus-night-muted">{hint}</div>}
      </div>

      <div className="rounded-md border border-citrus-border bg-citrus-card px-2.5 py-2 dark:border-citrus-night-border dark:bg-citrus-night-card">
        <div className="text-[11px] text-citrus-muted dark:text-citrus-night-muted">Last run used</div>
        {lastModel ? (
          <div className="mt-0.5 font-mono text-[12px] text-citrus-dark dark:text-citrus-night-text">{lastModel}</div>
        ) : (
          <div className="mt-0.5 text-[11px] text-citrus-muted dark:text-citrus-night-muted">Send a message to find out.</div>
        )}
      </div>

      <div className="flex items-center justify-between pt-1">
        <span className="text-[11px] text-citrus-pink">{msg}</span>
        <button
          onClick={() => void saveSettings()}
          className="rounded-md border border-citrus-border px-2.5 py-1 text-[11px] font-bold text-citrus-dark hover:bg-citrus-sand/60 dark:border-citrus-night-border dark:text-citrus-night-text dark:hover:bg-citrus-night-elev"
        >
          Save settings
        </button>
      </div>
    </div>
  )
}
