import { describe, it, expect } from 'vitest'
import { discoverScalarPaths } from './jsonPaths'

// A representative O365 Unified Audit Log `AuditData` blob — most real content lives here, which is
// exactly the column an analyst expands in Excel today.
const AUDIT_DATA = JSON.stringify({
  CreationTime: '2021-04-22T15:00:22',
  Id: 'b1c2-d3e4',
  Operation: 'MailItemsAccessed',
  OrganizationId: 'org-1',
  RecordType: 50,
  ResultStatus: 'Succeeded',
  Workload: 'Exchange',
  ClientIPAddress: '2001:db8:10:1d9:cafe::3c',
  UserId: 'user1@example.onmicrosoft.com',
  Folders: [{ Path: '\\Inbox', FolderItems: [{ InternetMessageId: '<msg1@example.com>' }] }],
  OperationProperties: [{ Name: 'MailAccessType', Value: 'Bind' }]
})

describe('discoverScalarPaths', () => {
  it('discovers top-level scalar fields with paths + examples', () => {
    const fields = discoverScalarPaths([AUDIT_DATA])
    const op = fields.find((f) => f.key === 'Operation')
    expect(op).toEqual({ path: '$.Operation', key: 'Operation', kind: 'scalar', example: 'MailItemsAccessed' })

    const ip = fields.find((f) => f.key === 'ClientIPAddress')
    expect(ip?.kind).toBe('scalar')
    expect(ip?.path).toBe('$.ClientIPAddress')

    const rt = fields.find((f) => f.key === 'RecordType') // numbers are scalars too
    expect(rt).toMatchObject({ kind: 'scalar', example: '50' })

    const scalarKeys = fields.filter((f) => f.kind === 'scalar').map((f) => f.key)
    expect(scalarKeys).toEqual(
      expect.arrayContaining(['CreationTime', 'Operation', 'ResultStatus', 'UserId', 'ClientIPAddress'])
    )
  })

  it('reports nested arrays/objects (not as scalars)', () => {
    const fields = discoverScalarPaths([AUDIT_DATA])
    expect(fields.find((f) => f.key === 'Folders')?.kind).toBe('array')
    expect(fields.find((f) => f.key === 'OperationProperties')?.kind).toBe('array')
    // arrays/objects are excluded from the extractable set
    expect(fields.filter((f) => f.kind === 'scalar').some((f) => f.key === 'Folders')).toBe(false)
  })

  it('unions keys across rows (sparse fields appear once)', () => {
    const a = JSON.stringify({ Operation: 'New-InboxRule', RuleName: 'Forward all' })
    const b = JSON.stringify({ Operation: 'MailItemsAccessed', ClientIP: '10.14.22.9' })
    const fields = discoverScalarPaths([a, b])
    const keys = fields.map((f) => f.key)
    expect(keys).toEqual(['Operation', 'RuleName', 'ClientIP']) // first-seen order, unioned
  })

  it('preserves discovery order and first-seen example', () => {
    const fields = discoverScalarPaths([JSON.stringify({ b: 2, a: 1 })])
    expect(fields.map((f) => f.key)).toEqual(['b', 'a'])
  })

  it('upgrades a null first example to a later real scalar', () => {
    const fields = discoverScalarPaths([JSON.stringify({ Note: null }), JSON.stringify({ Note: 'hello' })])
    expect(fields.find((f) => f.key === 'Note')).toMatchObject({ kind: 'scalar', example: 'hello' })
  })

  it('skips empty, non-JSON, and non-object samples', () => {
    expect(discoverScalarPaths(['', '   ', 'not json', '[1,2,3]', '42'])).toEqual([])
  })

  it('quotes keys that are not simple identifiers', () => {
    const fields = discoverScalarPaths([JSON.stringify({ 'Client IP': '203.0.113.4' })])
    expect(fields[0]).toMatchObject({ path: '$."Client IP"', key: 'Client IP', kind: 'scalar' })
  })
})
