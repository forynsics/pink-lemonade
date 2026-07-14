import { describe, expect, it } from 'vitest'
import { CLAUDE_CODE_MODELS, buildPrompt, explainRunError, isPresetModel, modelWasUsed, noModelRanMessage, textDeltaFromStreamEvent } from './claudeCode'

describe('textDeltaFromStreamEvent', () => {
  it('extracts text from a content_block_delta text_delta', () => {
    expect(textDeltaFromStreamEvent({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } })).toBe('hi')
  })

  it('ignores tool input deltas and other events', () => {
    expect(textDeltaFromStreamEvent({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{' } })).toBeNull()
    expect(textDeltaFromStreamEvent({ type: 'message_start' })).toBeNull()
    expect(textDeltaFromStreamEvent(null)).toBeNull()
  })
})

describe('buildPrompt', () => {
  it('returns the single message content directly', () => {
    expect(buildPrompt([{ role: 'user', content: 'hello' }])).toBe('hello')
  })

  it('flattens prior turns into a conversation preamble', () => {
    const out = buildPrompt([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'second' }
    ])
    expect(out).toContain('Conversation so far:')
    expect(out).toContain('User: first')
    expect(out).toContain('Assistant: reply')
    expect(out.trimEnd().endsWith('User: second')).toBe(true)
  })

  it('handles an empty history', () => {
    expect(buildPrompt([])).toBe('')
  })
})

describe('CLAUDE_CODE_MODELS', () => {
  it('offers aliases, never pinned snapshot ids (which go stale)', () => {
    for (const m of CLAUDE_CODE_MODELS) expect(m.id).not.toMatch(/^claude-/)
  })

  it('leads with the empty id, so the default is to send no model at all', () => {
    expect(CLAUDE_CODE_MODELS[0].id).toBe('')
  })

  it('does not offer the "default" alias — it would override the user\'s own /model pick', () => {
    expect(CLAUDE_CODE_MODELS.map((m) => m.id)).not.toContain('default')
  })
})

describe('isPresetModel', () => {
  it('accepts the offered aliases and the empty default', () => {
    expect(isPresetModel('')).toBe(true)
    expect(isPresetModel('opus')).toBe(true)
  })

  it('offers every current family, so a real choice never lands in Custom', () => {
    for (const alias of ['fable', 'opus', 'sonnet', 'haiku']) expect(isPresetModel(alias)).toBe(true)
  })

  it('rejects a pinned id, so the UI routes it to the custom field', () => {
    expect(isPresetModel('claude-opus-4-8')).toBe(false)
  })
})

// The messages Claude Code actually emits, verbatim from its error reference.
const PLAN_ERR = 'Claude Opus is not available with the Claude Pro plan. Select a different model in /model'
const SELECTED_ERR = "There's an issue with the selected model (claude-opus-4-8). It may not exist or you may not have access to it. Run /model to pick a different model."

describe('explainRunError', () => {
  it('appends a pointer to the setting when the plan cannot serve the model', () => {
    const out = explainRunError(PLAN_ERR, 'opus')
    expect(out).toContain(PLAN_ERR)
    expect(out).toContain('"opus"')
    expect(out).toContain('Settings → Model')
  })

  it('catches the selected-model error, which never uses the word "plan"', () => {
    expect(explainRunError(SELECTED_ERR, 'claude-opus-4-8')).toContain('Settings → Model')
  })

  it('blames the Claude Code default when we sent no model', () => {
    const out = explainRunError(SELECTED_ERR, '')
    expect(out).toContain('your Claude Code default model')
    expect(out).not.toContain('""')
  })

  it('passes unrelated failures through untouched', () => {
    const msg = 'ECONNREFUSED: could not reach the server'
    expect(explainRunError(msg, 'opus')).toBe(msg)
  })

  it('does not fire on a message that merely mentions a model', () => {
    const msg = 'The model returned an empty response'
    expect(explainRunError(msg, 'opus')).toBe(msg)
  })
})

// The modelUsage shapes below are what the SDK actually returned when probed against a real
// Claude Code install — a bogus model reports SUCCESS with no usage rather than erroring.
describe('modelWasUsed', () => {
  it('is true when a model was invoked', () => {
    expect(modelWasUsed({ subtype: 'success', modelUsage: { 'claude-opus-4-8[1m]': { in: 1 } } })).toBe(true)
  })

  it('is true when a sub-agent pulled in a second model', () => {
    expect(modelWasUsed({ modelUsage: { 'claude-haiku-4-5-20251001': {}, 'claude-sonnet-5': {} } })).toBe(true)
  })

  it('is false for the silent no-op: success with empty usage (an unusable model)', () => {
    expect(modelWasUsed({ subtype: 'success', modelUsage: {} })).toBe(false)
  })

  it('is false when usage is missing entirely, and survives junk', () => {
    expect(modelWasUsed({ subtype: 'success' })).toBe(false)
    expect(modelWasUsed(null)).toBe(false)
    expect(modelWasUsed(undefined)).toBe(false)
  })
})

describe('noModelRanMessage', () => {
  it('names the requested model', () => {
    expect(noModelRanMessage('claude-typo-9')).toContain('"claude-typo-9"')
  })

  it('blames the Claude Code default when we sent none', () => {
    const out = noModelRanMessage('')
    expect(out).toContain('your Claude Code default model')
    expect(out).not.toContain('""')
  })

  it('is not re-decorated by explainRunError (it already points at the setting)', () => {
    const msg = noModelRanMessage('opus')
    expect(explainRunError(msg, 'opus')).toBe(msg)
    expect(msg.match(/Settings → Model/g)).toHaveLength(1)
  })
})
