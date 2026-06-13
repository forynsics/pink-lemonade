import { describe, expect, it } from 'vitest'
import '../tools' // registers every tool
import { runWorkflow } from './workflow'

describe('runWorkflow', () => {
  it('chains base64 decode -> extract IPv4 -> dedup', () => {
    const b64 = btoa('see 8.8.8.8 and 8.8.8.8 and 9.9.9.9')
    const res = runWorkflow(b64, [
      { toolId: 'text.base64.decode', options: {} },
      { toolId: 'ioc.extract.ipv4', options: {} },
      { toolId: 'text.dedup', options: { sort: true } }
    ])
    expect(res.error).toBeUndefined()
    expect(res.output.split('\n')).toEqual(['8.8.8.8', '9.9.9.9'])
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
})
