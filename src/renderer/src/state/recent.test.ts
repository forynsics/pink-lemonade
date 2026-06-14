import { describe, it, expect } from 'vitest'
import { addRecent, removeRecent, type RecentFile } from './recent'

const mk = (path: string, openedAt = 1): RecentFile => ({
  path,
  sourceName: path.split('/').pop() ?? path,
  rowCount: 10,
  openedAt
})

describe('addRecent', () => {
  it('puts the newest file at the front', () => {
    const list = addRecent(addRecent([], mk('/a.csv')), mk('/b.csv'))
    expect(list.map((f) => f.path)).toEqual(['/b.csv', '/a.csv'])
  })

  it('de-dupes by path and moves the re-opened file to the front', () => {
    const list = [mk('/a.csv'), mk('/b.csv'), mk('/c.csv')]
    const next = addRecent(list, mk('/c.csv', 99))
    expect(next.map((f) => f.path)).toEqual(['/c.csv', '/a.csv', '/b.csv'])
    expect(next[0].openedAt).toBe(99)
    expect(next.filter((f) => f.path === '/c.csv')).toHaveLength(1)
  })

  it('caps the list at 12 entries', () => {
    let list: RecentFile[] = []
    for (let i = 0; i < 20; i++) list = addRecent(list, mk(`/f${i}.csv`))
    expect(list).toHaveLength(12)
    expect(list[0].path).toBe('/f19.csv') // most recent kept
  })
})

describe('removeRecent', () => {
  it('drops a stale entry by path', () => {
    const list = [mk('/a.csv'), mk('/b.csv')]
    expect(removeRecent(list, '/a.csv').map((f) => f.path)).toEqual(['/b.csv'])
  })
})
