import { describe, it, expect } from 'vitest'
import { createInspector } from '@noy-db/in-devtools'
import { groupInspector } from '../src/federation/group-inspector.js'
import { makeTwoShardGroup, type Invoice } from './helpers/two-shard-group.js'

describe('groupInspector', () => {
  it('lists the group shards and snapshots one', async () => {
    const { group } = await makeTwoShardGroup()
    const inspector = createInspector(groupInspector(group))

    const vaults = await inspector.listVaults()
    expect(vaults.map((v) => v.id).sort()).toEqual(['firm-clients--acme', 'firm-clients--bigco'])
    expect(vaults.every((v) => v.role === 'owner')).toBe(true)

    const acme = await group.shard('acme')
    const snap = await inspector.snapshot(acme)
    expect(snap.collections.map((c) => c.name)).toContain('invoices')
  })

  it('scopes write events to the group shards (ignores non-group vaults)', async () => {
    const { group, db } = await makeTwoShardGroup()
    const inspector = createInspector(groupInspector(group))
    await inspector.listVaults() // prime the shard-id set

    const seen: string[] = []
    const unsub = inspector.subscribe((e) => seen.push(e.vault))

    // a write to a vault OUTSIDE the group must NOT surface
    const outsider = await db.openVault('outsider')
    await outsider.collection<{ id: string }>('notes').put('n1', { id: 'n1' })
    // a write to a group shard MUST surface
    const bigco = await group.shard('bigco')
    await bigco.collection<Invoice>('invoices').put('b2', { clientId: 'bigco', amount: 5, status: 'open' })

    await new Promise((r) => setTimeout(r, 20))
    unsub()

    expect(seen).toContain('firm-clients--bigco')
    expect(seen).not.toContain('outsider')
  })
})
