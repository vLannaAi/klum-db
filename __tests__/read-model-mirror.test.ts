/**
 * Federated read-model S2 (#44/#56): mirror shape.
 *
 * `kind: 'mirror'` replicates each shard's `source` collection
 * (plain or #810-MV-output — the engine is agnostic) row-by-row into
 * one group-wide queryable collection. Deterministic ids
 * `${shard}:${idOf(row)}`, `_shard`/`_sourceId`/`_sourceVersion`
 * provenance, refresh-time reconciliation (deleted sources and
 * departed shards retract; skipped shards never cause retraction).
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { toMemory } from '@noy-db/to-memory'
import type { Vault } from '@noy-db/hub'
import { createLobby, PostureViolationError, type VaultRegistryRow } from '../src/index.js'

interface Bill { id: string; clientId: string; amount: number; status: string }

async function buildFleet() {
  const adapter = toMemory()
  const db = await createNoydb({ store: adapter, user: 'operator', secret: 'op-pass' })
  const lobby = createLobby(db)
  lobby.withVaultTemplate('client-template', {
    version: 1,
    configure: (v: Vault) => { v.collection<Bill>('bills') },
  })
  const state = await db.openVault('state')
  const registry = state.collection<VaultRegistryRow>('vault-registry')
  const group = await lobby.openVaultGroup<Bill>('firm', {
    registry,
    sharding: { keyOf: (r) => r.clientId, vaultTemplate: 'client-template' },
  })
  await group.collection('bills').put('b1', { id: 'b1', clientId: 'acme', amount: 100, status: 'paid' })
  await group.collection('bills').put('b2', { id: 'b2', clientId: 'acme', amount: 50, status: 'overdue' })
  await group.collection('bills').put('b3', { id: 'b3', clientId: 'beta', amount: 200, status: 'paid' })
  return { db, lobby, group, registry }
}

const ALL_BILLS = {
  name: 'all-bills',
  kind: 'mirror',
  source: 'bills',
  idOf: (row: Bill) => row.id,
  posture: { surface: ['id', 'clientId', 'amount', 'status'] },
} as const

describe('Lobby.openReadModel — S2 mirror (#44/#56)', () => {
  it('replicates every shard row under ${shard}:${id} with full provenance', async () => {
    const { lobby, group } = await buildFleet()
    const rm = await lobby.openReadModel(group, { vault: 'insight--firm', models: [ALL_BILLS] })

    const res = await rm.refresh()

    expect(res.written).toBe(3)
    expect(res.retracted).toBe(0)
    const b1 = await rm.collection('all-bills').get('acme:b1')
    expect(b1).toMatchObject({ id: 'b1', amount: 100, _shard: 'acme', _sourceId: 'b1', _sourceVersion: 1 })
    expect(await rm.collection('all-bills').get('beta:b3')).toMatchObject({ amount: 200, _shard: 'beta' })
    await rm.collection('all-bills').list()
    expect(rm.collection('all-bills').query().toArray()).toHaveLength(3)
  })

  it('reconciles on re-refresh: source update reflected, source delete retracted', async () => {
    const { lobby, group } = await buildFleet()
    const rm = await lobby.openReadModel(group, { vault: 'insight--firm', models: [ALL_BILLS] })
    await rm.refresh()

    const acme = await group.openShard('acme')
    await acme.collection<Bill>('bills').put('b2', { id: 'b2', clientId: 'acme', amount: 75, status: 'paid' })
    await acme.collection<Bill>('bills').delete('b1')
    const res = await rm.refresh()

    expect(res.retracted).toBe(1)
    expect(await rm.collection('all-bills').get('acme:b1')).toBeNull()
    expect(await rm.collection('all-bills').get('acme:b2')).toMatchObject({ amount: 75, status: 'paid', _sourceVersion: 2 })
  })

  it('a shard leaving the group retracts all its rows on the next refresh', async () => {
    const { lobby, group, registry } = await buildFleet()
    const rm = await lobby.openReadModel(group, { vault: 'insight--firm', models: [ALL_BILLS] })
    await rm.refresh()

    await registry.delete(group.registryId('beta'))
    const res = await rm.refresh()

    expect(res.retracted).toBe(1)
    expect(await rm.collection('all-bills').get('beta:b3')).toBeNull()
    expect(await rm.collection('all-bills').get('acme:b1')).not.toBeNull()
  })

  it('a skipped (unreachable) shard is reported, and causes no retraction', async () => {
    const { lobby, group, registry } = await buildFleet()
    const rm = await lobby.openReadModel(group, { vault: 'insight--firm', models: [ALL_BILLS] })
    await rm.refresh()

    await registry.put('firm--ghost', {
      vaultId: 'firm--ghost', partitionKey: 'ghost', templateName: 'client-template',
      schemaVersion: 1, createdAt: 1, group: 'firm',
    })
    const res = await rm.refresh()

    expect(res.skippedVaults.map((s) => s.vaultId)).toEqual(['firm--ghost'])
    expect(res.retracted).toBe(0)
    await rm.collection('all-bills').list()
    expect(rm.collection('all-bills').query().toArray()).toHaveLength(3)
  })

  it('fails closed when a source row carries a field outside posture.surface', async () => {
    const { lobby, group } = await buildFleet()
    const acme = await group.openShard('acme')
    await acme.collection<Bill & { note?: string }>('bills').put('b9', {
      id: 'b9', clientId: 'acme', amount: 1, status: 'paid', note: 'private memo',
    })
    const rm = await lobby.openReadModel(group, { vault: 'insight--firm', models: [ALL_BILLS] })

    const err = await rm.refresh().then(() => null, (e: unknown) => e as PostureViolationError)

    expect(err).toBeInstanceOf(PostureViolationError)
    expect(err!.message).toContain('note')
    expect(await rm.collection('all-bills').get('acme:b9')).toBeNull()
  })

  it('rollup and mirror models coexist in one read-model', async () => {
    const { lobby, group } = await buildFleet()
    const rm = await lobby.openReadModel(group, {
      vault: 'insight--firm',
      models: [
        ALL_BILLS,
        {
          name: 'firm-billing', kind: 'rollup', source: 'bills',
          derive: (records: Bill[]) => ({ billed: records.reduce((n, r) => n + r.amount, 0) }),
          posture: { surface: ['billed'] },
        },
      ],
    })

    const res = await rm.refresh()

    expect(res.written).toBe(5) // 3 mirrored + 2 summaries
    expect(await rm.collection('firm-billing').get('acme')).toMatchObject({ billed: 150 })
    expect(await rm.collection('all-bills').get('beta:b3')).toMatchObject({ amount: 200 })
  })
})
