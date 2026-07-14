import { describe, expect, it } from 'vitest'
import '../tools' // registers every tool
import { runWorkflow } from './workflow'

describe('runWorkflow', () => {
  it('chains base64 decode -> extract IPv4 -> dedup', () => {
    const b64 = btoa('see 192.0.2.10 and 192.0.2.10 and 198.51.100.20')
    const res = runWorkflow(b64, [
      { toolId: 'text.base64.decode', options: {} },
      { toolId: 'ioc.extract.ipv4', options: {} },
      { toolId: 'text.dedup', options: { sort: true } }
    ])
    expect(res.error).toBeUndefined()
    expect(res.output.split('\n')).toEqual(['192.0.2.10', '198.51.100.20'])
  })

  it('returns input unchanged when there are no steps', () => {
    expect(runWorkflow('hello', []).output).toBe('hello')
  })

  it('captures a failing step without throwing and stops the chain', () => {
    const res = runWorkflow('not base64!!', [
      { toolId: 'text.base64.decode', options: {} },
      { toolId: 'text.case', options: { mode: 'upper' } }
    ])
    expect(res.error).toBeTruthy()
    expect(res.steps).toHaveLength(1)
  })

  it('reports an unknown tool id', () => {
    const res = runWorkflow('x', [{ toolId: 'does.not.exist', options: {} }])
    expect(res.error).toContain('Unknown tool')
  })

  it('bypasses a disabled step (passthrough) and continues the chain', () => {
    const res = runWorkflow('see 203.0.113.7 here', [
      { toolId: 'ioc.extract.ipv4', options: {}, enabled: false },
      { toolId: 'text.case', options: { mode: 'upper' } }
    ])
    expect(res.error).toBeUndefined()
    // The extractor was skipped, so the uppercase step acts on the original input.
    expect(res.output).toBe('SEE 203.0.113.7 HERE')
    expect(res.steps).toHaveLength(2)
    expect(res.steps[0].output).toBe('see 203.0.113.7 here') // passthrough
  })
})
