// The ai:* IPC surface. The renderer invokes ai:chat and the run streams back over a single
// 'ai:event' channel (scoped to the invoking webContents via e.sender). The assistant is Claude,
// run through the user's own Claude Code login (their subscription) — no API key is stored here.
// Non-secret config (just the model) is persisted via the worker (settings.json is worker-owned).

import { ipcMain } from 'electron'
import * as dbw from '../csv/dbClient'
import { CLAUDE_CODE_MODELS, claudeCodeStatus, explainRunError, runClaudeCodeAgent } from './claudeCode'
import type { ChatRequest, PendingAction } from './types'

// In-flight runs by reqId, so ai:cancel can abort one without touching others.
const runs = new Map<number, AbortController>()
// Pending human-in-the-loop approvals by actionId; resolved when the renderer sends ai:actionResult.
const pendingActions = new Map<string, (approved: boolean) => void>()

async function getCfg(): Promise<Record<string, unknown>> {
  return dbw.call<Record<string, unknown>>('getAiConfig')
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' && v ? v : fallback
}

export function registerAiIpc(): void {
  // Config + readiness for the panel. Claude Code is the only backend; it rides the user's own login,
  // so there's no key to store — reachability/login is only known at run time.
  ipcMain.handle('ai:getConfig', async () => {
    const cfg = await getCfg()
    return {
      provider: 'claude-code',
      model: str(cfg.model),
      providers: [{ id: 'claude-code', name: 'Claude Code (your login)', ...claudeCodeStatus() }]
    }
  })

  ipcMain.handle('ai:setConfig', async (_e, { model }: { model?: string }) => {
    const patch: Record<string, unknown> = {}
    if (model !== undefined) patch.model = model
    await dbw.call('setAiConfig', patch)
    return { ok: true }
  })

  ipcMain.handle('ai:listModels', async () => CLAUDE_CODE_MODELS)

  ipcMain.handle('ai:chat', async (e, req: ChatRequest) => {
    const cfg = await getCfg()
    const model = req.model || str(cfg.model)

    const ac = new AbortController()
    runs.set(req.reqId, ac)
    const emit = (ev: unknown): void => {
      if (!e.sender.isDestroyed()) e.sender.send('ai:event', { reqId: req.reqId, ...(ev as object) })
    }

    // The human-in-the-loop gate: a state-changing tool calls this, which surfaces an action card to
    // the renderer and waits for the user's verdict (ai:actionResult). Aborting the run rejects it.
    let actionSeq = 0
    const requestApproval = (action: PendingAction): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        const actionId = `act_${req.reqId}_${actionSeq++}`
        const settle = (approved: boolean): void => {
          if (pendingActions.delete(actionId)) resolve(approved)
        }
        pendingActions.set(actionId, settle)
        emit({ type: 'action', actionId, kind: action.kind, summary: action.summary, detail: action.detail, tag: action.tag, count: action.count, sourceId: action.sourceId, group: action.group })
        if (ac.signal.aborted) settle(false)
        else ac.signal.addEventListener('abort', () => settle(false), { once: true })
      })
    const deps = { requestApproval }

    // A small note so the model knows the intel cache is reachable (read-only) this session.
    const providerNotes = ['Cached intel is available via get_cached_intel (no quota cost). Fetching new intel requires asking the user, which is not yet available.']
    const messages = req.messages ?? []

    try {
      // The Claude Agent SDK owns its own loop; the runner reuses our tools + system prompt. It
      // flattens history, so only the user/assistant turns are needed.
      const ccMessages = messages.reduce<Array<{ role: 'user' | 'assistant'; content: string }>>((acc, m) => {
        if (m.role === 'user' || m.role === 'assistant') acc.push({ role: m.role, content: 'content' in m && typeof m.content === 'string' ? m.content : '' })
        return acc
      }, [])
      await runClaudeCodeAgent({ messages: ccMessages, wsCtx: req.wsCtx, providerNotes, model: model || undefined, deps }, emit, ac.signal)
    } catch (err) {
      emit({ type: 'error', message: explainRunError(err instanceof Error ? err.message : String(err), model) })
    } finally {
      runs.delete(req.reqId)
    }
    return { ok: true }
  })

  // The renderer's verdict on a proposed action (Approve/Reject on an action card).
  ipcMain.handle('ai:actionResult', (_e, { actionId, approved }: { actionId: string; approved: boolean }) => {
    pendingActions.get(actionId)?.(!!approved)
    return null
  })

  ipcMain.handle('ai:cancel', (_e, { reqId }: { reqId: number }) => {
    runs.get(reqId)?.abort()
    return null
  })
}
