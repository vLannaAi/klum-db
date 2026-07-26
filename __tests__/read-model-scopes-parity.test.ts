/**
 * Federated read-model S4 (#44/#58): scoped audiences + parity harness.
 *
 * Scoping (spec § 5): audience = target vault, subset = `shards`
 * predicate over registry rows. A scoped read-model materializes only
 * its subset; rows of shards that fall out of scope RETRACT on refresh
 * (a narrower audience must not keep out-of-scope data); auto-push
 * respects the scope.
 *
 * Parity (spec § 7): the same records computed monolithically (one
 * vault) and federated (sharded group + read-model) must agree
 * row-for-row once engine provenance is stripped.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'
import type { Vault } from '@noy-db/hub'
import { createLobby, type VaultRegistryRow } from '../src/index.js'

interface Bill { id: string; clientId: string; amount: number; status: string }

const BILLS: Bill[] = [
  { id: 'b1', clientId: 'acme', amount: 100, status: 'paid' },
  { id: 'b2', clientId: 'acme', amount: 50, status: 'overdue' },
  { id: 'b3', clientId: 'beta', amount: 200, status: 'paid' },
  { id: 'b4', clientId: 'gamma', amount: 25, status: 'overdue' },
]

async function buildFleet() {
  const adapter = memory()
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
  for (const b of BILLS) await group.collection('bills').put(b.id, b)
  return { db, lobby, group, registry }
}

const ROLLUP = {
  name: 'billing', kind: 'rollup', source: 'bills',
  derive: (records: Bill[]) => ({
    billed: records.reduce((n, r) => n + r.amount, 0),
    overdue: records.filter((r) => r.status === 'overdue').length,
  }),
  posture: { surface: ['billed', 'overdue'] },
} as const

const MIRROR = {
  name: 'all-bills', kind: 'mirror', source: 'bills',
  idOf: (row: Bill) => row.id,
  posture: { surface: ['id', 'clientId', 'amount', 'status'] },
} as const

describe('ReadModel scoped audiences — S4 (#44/#58)', () => {
  it('a shards predicate materializes ONLY the subset (both shapes)', async () => {
    const { lobby, group } = await buildFleet()
    const advisorShards = new Set(['acme', 'beta'])
    const rm = await lobby.openReadModel(group, {
      vault: 'insight--advisor-1',
      models: [ROLLUP, MIRROR],
      shards: (row) => advisorShards.has(row.partitionKey),
    })

    const res = await rm.refresh()

    expect(res.written).toBe(5) // 2 summaries + 3 mirrored rows
    expect(await rm.collection('billing').get('gamma')).toBeNull()
    expect(await rm.collection('all-bills').get('gamma:b4')).toBeNull()
    expect(await rm.collection('billing').get('acme')).toMatchObject({ billed: 150, overdue: 1 })
  })

  it('rows of a shard that falls out of scope RETRACT on the next refresh', async () => {
    const { lobby, group } = await buildFleet()
    const scope = new Set(['acme', 'beta'])
    const rm = await lobby.openReadModel(group, {
      vault: 'insight--advisor-1',
      models: [MIRROR],
      shards: (row) => scope.has(row.partitionKey),
    })
    await rm.refresh()
    expect(await rm.collection('all-bills').get('beta:b3')).not.toBeNull()

    scope.delete('beta') // audience narrowed
    const res = await rm.refresh()

    expect(res.retracted).toBe(1)
    expect(await rm.collection('all-bills').get('beta:b3')).toBeNull()
    expect(await rm.collection('all-bills').get('acme:b1')).not.toBeNull()
  })

  it('auto-push respects the scope: an out-of-scope shard write pushes nothing', async () => {
    const { lobby, group } = await buildFleet()
    const rm = await lobby.openReadModel(group, {
      vault: 'insight--advisor-1',
      models: [MIRROR],
      shards: (row) => row.partitionKey === 'acme',
      freshness: { autoPush: true },
    })
    await rm.refresh()

    await group.collection('bills').put('b9', { id: 'b9', clientId: 'gamma', amount: 9, status: 'paid' })
    await rm.whenSettled()

    expect(await rm.collection('all-bills').get('gamma:b9')).toBeNull()
    await rm.collection('all-bills').list()
    expect(rm.collection('all-bills').query().toArray()).toHaveLength(2)
  })
})

describe('ReadModel parity harness — S4 (#44/#58, spec § 7)', () => {
  it('federated read-model equals the monolith computation row-for-row', async () => {
    // ── monolith: one vault, one collection, computed directly ────────────
    const mono = await createNoydb({ store: memory(), user: 'op', secret: 'op-pass' })
    const monoVault = await mono.openVault('books')
    const monoBills = monoVault.collection<Bill>('bills')
    for (const b of BILLS) await monoBills.put(b.id, b)
    const monoRecords = await monoBills.list()
    // the pre-federation computation: group by client, reduce
    const monoRollup = new Map<string, { billed: number; overdue: number }>()
    for (const r of monoRecords) {
      const cur = monoRollup.get(r.clientId) ?? { billed: 0, overdue: 0 }
      monoRollup.set(r.clientId, {
        billed: cur.billed + r.amount,
        overdue: cur.overdue + (r.status === 'overdue' ? 1 : 0),
      })
    }

    // ── federated: sharded group + read-model ─────────────────────────────
    const { lobby, group } = await buildFleet()
    const rm = await lobby.openReadModel(group, { vault: 'insight--firm', models: [ROLLUP, MIRROR] })
    await rm.refresh()

    // rollup parity: every client's summary equals the monolith reduce
    for (const [client, expected] of monoRollup) {
      const row = await rm.collection('billing').get(client)
      expect(row, `rollup parity for ${client}`).toMatchObject(expected)
    }
    // mirror parity: every monolith record appears exactly once, values equal
    await rm.collection('all-bills').list()
    const mirrored = rm.collection('all-bills').query().toArray()
    expect(mirrored).toHaveLength(monoRecords.length)
    for (const r of monoRecords) {
      const row = await rm.collection<Record<string, unknown>>('all-bills').get(`${r.clientId}:${r.id}`)
      const { _shard, _sourceId, _sourceVersion, ...values } = row as Record<string, unknown>
      expect(values, `mirror parity for ${r.id}`).toEqual(r)
    }
    await mono.close()
  })
})
