/**
 * Federated read-model S1 (#44/#55): engine + rollup shape.
 *
 * `lobby.openReadModel(group, { vault, models })` — a maintained,
 * queryable read-model vault composing per-shard collections across a
 * VaultGroup. S1 ships the rollup shape: per-shard reduce → one summary
 * row per shard, deterministic ids, `_shard`/`_sourceVersion`
 * provenance, fail-closed `posture.surface` allowlist, explicit
 * `refresh()`. Spec: docs/federated-read-model.md.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, ValidationError } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'
import type { Vault } from '@noy-db/hub'
import { createLobby, PostureViolationError, type VaultRegistryRow } from '../src/index.js'

interface Invoice { clientId: string; amount: number; status: string }

async function buildFleet() {
  const adapter = memory()
  const db = await createNoydb({ store: adapter, user: 'operator', secret: 'op-pass' })
  const lobby = createLobby(db)
  lobby.withVaultTemplate('client-template', {
    version: 1,
    configure: (v: Vault) => { v.collection<Invoice>('invoices') },
  })
  const state = await db.openVault('state')
  const registry = state.collection<VaultRegistryRow>('vault-registry')
  const group = await lobby.openVaultGroup<Invoice>('firm', {
    registry,
    sharding: { keyOf: (r) => r.clientId, vaultTemplate: 'client-template' },
  })
  await group.collection('invoices').put('a1', { clientId: 'acme', amount: 100, status: 'paid' })
  await group.collection('invoices').put('a2', { clientId: 'acme', amount: 50, status: 'overdue' })
  await group.collection('invoices').put('b1', { clientId: 'beta', amount: 200, status: 'paid' })
  return { db, lobby, group, registry }
}

const BILLING_MODEL = {
  name: 'firm-billing',
  kind: 'rollup',
  source: 'invoices',
  derive: (records: Invoice[]) => ({
    billed: records.reduce((n, r) => n + r.amount, 0),
    count: records.length,
  }),
  posture: { surface: ['billed', 'count'] },
} as const

describe('Lobby.openReadModel — S1 rollup (#44/#55)', () => {
  it('refresh() writes one summary row per shard with deterministic id + provenance', async () => {
    const { lobby, group } = await buildFleet()
    const rm = await lobby.openReadModel(group, { vault: 'insight--firm', models: [BILLING_MODEL] })

    const res = await rm.refresh()

    expect(res.written).toBe(2)
    expect(res.skippedVaults).toEqual([])
    const rows = rm.collection('firm-billing')
    const acme = await rows.get('acme')
    expect(acme).toMatchObject({ billed: 150, count: 2, _shard: 'acme', _sourceVersion: 1 })
    const beta = await rows.get('beta')
    expect(beta).toMatchObject({ billed: 200, count: 1, _shard: 'beta' })
  })

  it('re-refresh overwrites in place — still one row per shard, updated values', async () => {
    const { lobby, group } = await buildFleet()
    const rm = await lobby.openReadModel(group, { vault: 'insight--firm', models: [BILLING_MODEL] })
    await rm.refresh()

    await group.collection('invoices').put('a3', { clientId: 'acme', amount: 25, status: 'paid' })
    const res = await rm.refresh()

    expect(res.written).toBe(2)
    const acme = await rm.collection('firm-billing').get('acme')
    expect(acme).toMatchObject({ billed: 175, count: 3 })
    await rm.collection('firm-billing').list()
    expect(rm.collection('firm-billing').query().toArray()).toHaveLength(2)
  })

  it('fails closed on a posture violation: undeclared emitted field → typed error, row not written', async () => {
    const { lobby, group } = await buildFleet()
    const rm = await lobby.openReadModel(group, {
      vault: 'insight--firm',
      models: [{
        ...BILLING_MODEL,
        name: 'leaky',
        derive: (records: Invoice[]) => ({
          billed: records.reduce((n, r) => n + r.amount, 0),
          count: records.length,
          statuses: records.map((r) => r.status), // NOT in posture.surface
        }),
      }],
    })

    const err = await rm.refresh().then(() => null, (e: unknown) => e as PostureViolationError)

    expect(err).toBeInstanceOf(PostureViolationError)
    expect(err!.message).toContain('statuses')
    expect(err!.message).toContain('leaky')
    expect(await rm.collection('leaky').get('acme')).toBeNull()
  })

  it('a shard whose vault is gone lands in skippedVaults; healthy shards still written', async () => {
    const { lobby, group, registry } = await buildFleet()
    await registry.put('firm--ghost', {
      vaultId: 'firm--ghost', partitionKey: 'ghost', templateName: 'client-template',
      schemaVersion: 1, createdAt: 1, group: 'firm',
    })
    const rm = await lobby.openReadModel(group, { vault: 'insight--firm', models: [BILLING_MODEL] })

    const res = await rm.refresh()

    expect(res.written).toBe(2)
    expect(res.skippedVaults.map((s) => s.vaultId)).toEqual(['firm--ghost'])
    expect(res.skippedVaults[0]?.reason).toBe('error')
  })

  it('multiple models refresh into their own collections', async () => {
    const { lobby, group } = await buildFleet()
    const rm = await lobby.openReadModel(group, {
      vault: 'insight--firm',
      models: [
        BILLING_MODEL,
        {
          name: 'firm-overdue', kind: 'rollup', source: 'invoices',
          derive: (records: Invoice[]) => ({ overdue: records.filter((r) => r.status === 'overdue').length }),
          posture: { surface: ['overdue'] },
        },
      ],
    })

    const res = await rm.refresh()

    expect(res.written).toBe(4)
    expect(await rm.collection('firm-overdue').get('acme')).toMatchObject({ overdue: 1 })
    expect(await rm.collection('firm-overdue').get('beta')).toMatchObject({ overdue: 0 })
  })

  it('rejects a read-model vault that is a shard of the group (or the group itself)', async () => {
    const { lobby, group } = await buildFleet()

    await expect(
      lobby.openReadModel(group, { vault: 'firm--acme', models: [BILLING_MODEL] }),
    ).rejects.toThrow(ValidationError)
    await expect(
      lobby.openReadModel(group, { vault: 'firm', models: [BILLING_MODEL] }),
    ).rejects.toThrow(ValidationError)
  })
})
