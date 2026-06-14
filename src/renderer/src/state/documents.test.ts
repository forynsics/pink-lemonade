import { beforeEach, describe, expect, it } from 'vitest'
import { saveDocs, loadDocs, createDoc, createWorkspaceDoc, type DocsState, type ScratchDoc } from './documents'

// Minimal localStorage stand-in (Vitest runs in the node env, which has none).
beforeEach(() => {
  const store = new Map<string, string>()
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0
  } as Storage
})

function stateWith(input: string): DocsState {
  const doc: ScratchDoc = { ...createDoc('Doc'), input }
  return { docs: [doc], activeId: doc.id }
}

/** Narrow a loaded doc to a scratch doc (throws if it isn't). */
function scratch(d: DocsState['docs'][number] | undefined): ScratchDoc {
  if (!d || d.kind !== 'scratch') throw new Error('expected scratch doc')
  return d
}

describe('document persistence', () => {
  it('round-trips a normal-sized input', () => {
    saveDocs(stateWith('hello world'))
    const doc = scratch(loadDocs()?.docs[0])
    expect(doc.input).toBe('hello world')
    expect(doc.inputDropped).toBe(false)
  })

  it('drops an oversized input but keeps a valid doc', () => {
    saveDocs(stateWith('x'.repeat(1_000_001)))
    const loaded = loadDocs()
    expect(loaded).not.toBeNull()
    const doc = scratch(loaded?.docs[0])
    expect(doc.input).toBe('')
    expect(doc.inputDropped).toBe(true)
    expect(doc.name).toBe('Doc') // the tab itself (id/name/steps) still persists
  })

  it('migrates an old persisted doc with no kind to a scratch doc', () => {
    localStorage.setItem(
      'pink-lemonade:docs',
      JSON.stringify({ activeId: 'a', docs: [{ id: 'a', name: 'Legacy', input: 'hi', steps: [] }] })
    )
    const doc = scratch(loadDocs()?.docs[0])
    expect(doc.kind).toBe('scratch')
    expect(doc.input).toBe('hi')
  })

  it('persists a workspace as metadata only and reloads it needing re-open', () => {
    const ws = createWorkspaceDoc({
      wsId: 'w1',
      name: 'ACME',
      dbPath: '/tmp/w1.workspace',
      sources: [{ sourceId: 0, name: 'log.csv', columns: [{ name: 'c0', original: 'ip' }], rowCount: 1234 }]
    })
    saveDocs({ docs: [ws], activeId: ws.id })
    const loaded = loadDocs()
    const d = loaded?.docs[0]
    expect(d?.kind).toBe('workspace')
    if (d?.kind === 'workspace') {
      expect(d.name).toBe('ACME')
      expect(d.sources).toHaveLength(1)
      expect(d.sources[0].rowCount).toBe(1234)
      expect(d.activeSourceId).toBe(0)
      expect(d.needsReopen).toBe(true) // db connection is fresh after restart
    }
  })

  it('drops obsolete pre-workspace CSV docs on load', () => {
    localStorage.setItem(
      'pink-lemonade:docs',
      JSON.stringify({
        activeId: 'c',
        docs: [
          { id: 'c', kind: 'csv', name: 'old.csv', tabId: 't', dbPath: '/x', columns: [], rowCount: 1 },
          { id: 's', kind: 'scratch', name: 'Keep', input: 'hi', steps: [] }
        ]
      })
    )
    const loaded = loadDocs()
    expect(loaded?.docs).toHaveLength(1)
    expect(loaded?.docs[0].kind).toBe('scratch')
    expect(loaded?.activeId).toBe('s') // active fell back since the csv doc was dropped
  })
})
