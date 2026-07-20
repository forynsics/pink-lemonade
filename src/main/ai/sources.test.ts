import { describe, expect, it } from 'vitest'
import { pathOf, resolveSource } from './sources'
import type { WsCtx, WsSource } from './types'

const src = (sourceId: number, name: string, group?: string): WsSource => ({ sourceId, tabId: `ws1:${sourceId}`, name, columns: [], rowCount: 100, group: group ?? null })

const ws: WsCtx = {
  hasWorkspace: true,
  wsId: 'ws1',
  activeSourceId: 2,
  sources: [src(1, 'Amcache_UnassociatedFileEntries.csv'), src(2, 'Hayabusa.csv'), src(3, 'MFTECmd_$MFT.csv')]
}

describe('resolveSource', () => {
  it('defaults to the on-screen (active) source when no ref is given', () => {
    expect(resolveSource(ws).name).toBe('Hayabusa.csv')
    expect(resolveSource(ws, '').name).toBe('Hayabusa.csv')
  })

  it('matches by exact name (case-insensitive)', () => {
    expect(resolveSource(ws, 'hayabusa.csv').sourceId).toBe(2)
  })

  it('matches by a unique substring', () => {
    expect(resolveSource(ws, 'amcache').sourceId).toBe(1)
    expect(resolveSource(ws, 'MFT').sourceId).toBe(3)
  })

  it('matches by numeric source id', () => {
    expect(resolveSource(ws, 3).name).toBe('MFTECmd_$MFT.csv')
    expect(resolveSource(ws, '1').name).toBe('Amcache_UnassociatedFileEntries.csv')
  })

  it('throws with the available names when nothing matches', () => {
    expect(() => resolveSource(ws, 'prefetch')).toThrow(/No source matches "prefetch".*Hayabusa\.csv/s)
  })

  it('throws when a substring is ambiguous', () => {
    const ws2: WsCtx = { hasWorkspace: true, wsId: 'ws1', activeSourceId: 1, sources: [src(1, 'EventLogs-System.csv'), src(2, 'EventLogs-Security.csv')] }
    expect(() => resolveSource(ws2, 'eventlogs')).toThrow(/matches multiple sources/)
  })

  it('throws when there is no workspace', () => {
    expect(() => resolveSource({ hasWorkspace: false, sources: [] })).toThrow(/No workspace is open/)
  })

  // Sources-as-files-in-folders: identical filenames across groups must stay distinguishable.
  const collide: WsCtx = {
    hasWorkspace: true,
    wsId: 'ws1',
    activeSourceId: 1,
    sources: [src(1, 'hayabusa_events_offline.csv', 'HOST-A'), src(2, 'hayabusa_events_offline.csv', 'HOST-B'), src(3, 'MFT.csv', 'HOST-A')]
  }

  it('resolves a group-qualified path "Group/name"', () => {
    expect(resolveSource(collide, 'HOST-B/hayabusa_events_offline.csv').sourceId).toBe(2)
    expect(resolveSource(collide, 'HOST-A/hayabusa_events_offline.csv').sourceId).toBe(1)
  })

  it('errors (not silently picks the first) when a bare name collides across groups', () => {
    expect(() => resolveSource(collide, 'hayabusa_events_offline.csv')).toThrow(/ambiguous.*HOST-A\/hayabusa_events_offline\.csv.*HOST-B\/hayabusa_events_offline\.csv/s)
  })

  it('still resolves a numeric id even when names collide', () => {
    expect(resolveSource(collide, 2).group).toBe('HOST-B')
  })

  it('formats a path as Group/name (or just name when ungrouped)', () => {
    expect(pathOf(src(1, 'MFT.csv', 'HOST-A'))).toBe('HOST-A/MFT.csv')
    expect(pathOf(src(1, 'MFT.csv'))).toBe('MFT.csv')
  })
})
