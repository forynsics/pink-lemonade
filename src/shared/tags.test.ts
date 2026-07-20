import { describe, it, expect } from 'vitest'
import { TAG_IDS, TAG_LABELS, isTagId } from './tags'

describe('tag vocabulary', () => {
  // These ids persist in the workspace db's `tags` table. Renaming one without a migration orphans
  // every row already tagged with it, which is why the test asserts the literal values.
  it('is the persisted set, in severity order', () => {
    expect(TAG_IDS).toEqual(['malicious', 'suspicious', 'unknown', 'benign'])
  })

  it('labels every id', () => {
    for (const id of TAG_IDS) expect(TAG_LABELS[id], `no label for "${id}"`).toBeTruthy()
  })

  it('recognises real ids and rejects anything else', () => {
    for (const id of TAG_IDS) expect(isTagId(id)).toBe(true)
    // Case matters: the grid looks tags up by exact id, so 'Malicious' would not render.
    expect(isTagId('Malicious')).toBe(false)
    expect(isTagId('bad')).toBe(false)
    expect(isTagId(undefined)).toBe(false)
  })
})
