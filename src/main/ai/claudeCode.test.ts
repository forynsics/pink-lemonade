import { describe, expect, it } from 'vitest'
import { buildPrompt, textDeltaFromStreamEvent } from './claudeCode'

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
