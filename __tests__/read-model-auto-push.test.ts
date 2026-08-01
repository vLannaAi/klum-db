/**
 * Federated read-model S3 (#44/#57): auto-push freshness.
 *
 * `freshness: { autoPush }` wires the #13 controller: a write landing
 * on a model's `source` collection re-derives THAT shard's contribution
 * only (rollup: one summary re-reduce; mirror: per-shard reconcile) —
 * never a full fan-out. Defaults off (explicit refresh() only).
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { toMemory } from '@noy-db/to-memory'
import type { Vault } from '@noy-db/hub'
import { createLobby, type VaultRegistryRow } from '../src/index.js'

interface Bill { id: string; clientId: string; amount: number }

async function buildFleet() {
  const adapter = toMemory()
  const db = await createNoydb({ store: adapter, user: 'operator', secret: 'op-pass' })
  const lobby = createLobby(db)
  lobby.withVaultTemplate('client-template', {
    version: 1,
    configure: (v: Vault) => {
      v.collection<Bill>('bills')
      v.collection<Record<string, unknown>>('notes')
    },
  })
  const state = await db.openVault('state')
  const registry = state.collection<VaultRegistryRow>('vault-registry')
  const group = await lobby.openVaultGroup<Bill>('firm', {
    registry,
    sharding: { keyOf: (r) => r.clientId, vaultTemplate: 'client-template' },
  })
  await group.collection('bills').put('b1', { id: 'b1', clientId: 'acme', amount: 100 })
  await group.collection('bills').put('b2', { id: 'b2', clientId: 'beta', amount: 200 })
  return { db, lobby, group, registry }
}

const MODELS = [
  {
    name: 'firm-billing', kind: 'rollup', source: 'bills',
    derive: (records: Bill[]) => ({ billed: records.reduce((n, r) => n + r.amount, 0) }),
    posture: { surface: ['billed'] },
  },
  {
    name: 'all-bills', kind: 'mirror', source: 'bills',
    idOf: (row: Bill) => row.id,
    posture: { surface: ['id', 'clientId', 'amount'] },
  },
] as const

describe('ReadModel auto-push — S3 (#44/#57)', () => {
  it('a shard write re-derives both shapes for THAT shard without an explicit refresh', async () => {
    const { lobby, group } = await buildFleet()
    const rm = await lobby.openReadModel(group, {
      vault: 'insight--firm', models: [...MODELS], freshness: { autoPush: true },
    })
    await rm.refresh()

    await group.collection('bills').put('b3', { id: 'b3', clientId: 'acme', amount: 50 })
    await rm.whenSettled()

    expect(await rm.collection('firm-billing').get('acme')).toMatchObject({ billed: 150 })
    expect(await rm.collection('all-bills').get('acme:b3')).toMatchObject({ amount: 50 })
    // the untouched shard's summary is NOT stale-refreshed (still valid, unchanged)
    expect(await rm.collection('firm-billing').get('beta')).toMatchObject({ billed: 200 })
  })

  it('a source delete auto-retracts the mirrored row for that shard', async () => {
    const { lobby, group } = await buildFleet()
    const rm = await lobby.openReadModel(group, {
      vault: 'insight--firm', models: [...MODELS], freshness: { autoPush: true },
    })
    await rm.refresh()

    const acme = await group.openShard('acme')
    await acme.collection<Bill>('bills').delete('b1')
    await rm.whenSettled()

    expect(await rm.collection('all-bills').get('acme:b1')).toBeNull()
    expect(await rm.collection('all-bills').get('beta:b2')).not.toBeNull()
    expect(await rm.collection('firm-billing').get('acme')).toMatchObject({ billed: 0 })
  })

  it('writes to non-source collections do not trigger a push', async () => {
    const { lobby, group } = await buildFleet()
    const rm = await lobby.openReadModel(group, {
      vault: 'insight--firm', models: [...MODELS], freshness: { autoPush: true },
    })
    await rm.refresh()

    const acme = await group.openShard('acme')
    await acme.collection<Record<string, unknown>>('notes').put('n1', { text: 'hi' })
    await rm.whenSettled()

    // still the refresh-time value — no recompute happened (billed unchanged is
    // trivially true; assert via the mirror: no phantom rows appeared)
    await rm.collection('all-bills').list()
    expect(rm.collection('all-bills').query().toArray()).toHaveLength(2)
  })

  it('without freshness.autoPush, shard writes do NOT update the read-model', async () => {
    const { lobby, group } = await buildFleet()
    const rm = await lobby.openReadModel(group, { vault: 'insight--firm', models: [...MODELS] })
    await rm.refresh()

    await group.collection('bills').put('b4', { id: 'b4', clientId: 'acme', amount: 999 })
    await rm.whenSettled()

    expect(await rm.collection('firm-billing').get('acme')).toMatchObject({ billed: 100 })
    expect(await rm.collection('all-bills').get('acme:b4')).toBeNull()
  })

  it('minVersion gating (#13): a behind-version shard is not recomputed', async () => {
    const { lobby, group, registry } = await buildFleet()
    const rm = await lobby.openReadModel(group, {
      vault: 'insight--firm', models: [...MODELS],
      freshness: { autoPush: { minVersion: 2 } },
    })
    await rm.refresh()
    const before = await rm.collection('firm-billing').get('acme')

    // acme is at schemaVersion 1 < minVersion 2 → its writes must not push
    await group.collection('bills').put('b5', { id: 'b5', clientId: 'acme', amount: 1 })
    await rm.whenSettled()

    expect(await rm.collection('firm-billing').get('acme')).toEqual(before)
    expect(await rm.collection('all-bills').get('acme:b5')).toBeNull()
    // sanity: the registry row really is below the floor
    expect((await registry.get(group.registryId('acme')))?.schemaVersion).toBe(1)
  })
})
