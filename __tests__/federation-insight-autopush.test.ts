import { describe, it, expect, vi } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'
import { createLobby } from '../src/index.js'
import type { VaultTemplate } from '../src/federation/index.js'
import { InsightAutoPush } from '../src/federation/insight-auto-push.js'
import type { InsightAutoPushConfig } from '../src/index.js'

// Compile guard — InsightAutoPushConfig must be exported from the public surface.
const _cfg: InsightAutoPushConfig = { debounceMs: 5, minVersion: 1 }; void _cfg

const template: VaultTemplate = { version: 1, configure: (v) => { v.collection('invoices') } }

// One summary row per shard: { count, total }.
function makeDerive() {
  return vi.fn((records: { amount?: number }[]) => ({
    count: records.length,
    total: records.reduce((s, r) => s + (r.amount ?? 0), 0),
  }))
}

async function setup(opts: { autoPush: boolean | { debounceMs?: number; minVersion?: number }; derive: ReturnType<typeof makeDerive>; templateVersion?: number }) {
  const db = await createNoydb({ store: memory(), user: 'firm', secret: 'firm-secret-12345' })
  const lobby = createLobby(db)
  lobby.withVaultTemplate('client', template)
  const group = await lobby.openVaultGroup<{ id: string }>('firm', {
    sharding: { keyOf: (r) => r.id, vaultTemplate: 'client', autoCreate: true },
  })
  group.withCrossVaultDerivation({
    source: 'invoices',
    target: { vault: 'firm-insight', collection: 'rollup' },
    derive: opts.derive,
    autoPush: opts.autoPush,
  })
  return { db, group }
}

async function readSummary(db: Awaited<ReturnType<typeof createNoydb>>, pk: string) {
  const insight = await db.openVault('firm-insight')
  return insight.collection('rollup').get(pk)
}

describe('VaultGroup — Insight auto-push-on-write', () => {
  it('auto-pushes a shard summary on write, with no explicit refreshInsights()', async () => {
    const derive = makeDerive()
    const { db, group } = await setup({ autoPush: true, derive })
    await group.collection('invoices').put('i1', { id: 'acme', amount: 100 } as never)
    await group.whenInsightsSettled()
    expect(await readSummary(db, 'acme')).toMatchObject({ count: 1, total: 100 })
  })

  it('coalesces a burst of writes to one shard into a derive that yields the final total', async () => {
    const derive = makeDerive()
    const { db, group } = await setup({ autoPush: true, derive })
    await group.collection('invoices').put('i1', { id: 'acme', amount: 1 } as never)
    await group.collection('invoices').put('i2', { id: 'acme', amount: 2 } as never)
    await group.collection('invoices').put('i3', { id: 'acme', amount: 3 } as never)
    await group.whenInsightsSettled()
    expect(derive).toHaveBeenCalled()
    expect(await readSummary(db, 'acme')).toMatchObject({ count: 3, total: 6 })
  })

  it('catches a DIRECT shard-handle write (group.shard(pk)), not just ShardedCollection', async () => {
    const derive = makeDerive()
    const { db, group } = await setup({ autoPush: true, derive })
    await group.collection('invoices').put('seed', { id: 'acme', amount: 5 } as never)
    await group.whenInsightsSettled()
    const shard = await group.shard('acme')
    await shard.collection('invoices').put('direct', { id: 'direct', amount: 7 })
    await group.whenInsightsSettled()
    expect(await readSummary(db, 'acme')).toMatchObject({ count: 2, total: 12 })
  })

  it('re-derives on delete (summary reflects the removal)', async () => {
    const derive = makeDerive()
    const { db, group } = await setup({ autoPush: true, derive })
    await group.collection('invoices').put('i1', { id: 'acme', amount: 100 } as never)
    await group.whenInsightsSettled()
    const shard = await group.shard('acme')
    await shard.collection('invoices').delete('i1')
    await group.whenInsightsSettled()
    expect(await readSummary(db, 'acme')).toMatchObject({ count: 0, total: 0 })
  })

  it('does NOT auto-push when autoPush is false (explicit refresh still required)', async () => {
    const derive = makeDerive()
    const { db, group } = await setup({ autoPush: false, derive })
    await group.collection('invoices').put('i1', { id: 'acme', amount: 100 } as never)
    await group.whenInsightsSettled()
    expect(await readSummary(db, 'acme')).toBeFalsy() // nothing pushed
    await group.refreshInsights()
    expect(await readSummary(db, 'acme')).toMatchObject({ count: 1, total: 100 })
  })

  it('pushes summaries for multiple shards dirtied in one batch', async () => {
    const derive = makeDerive()
    const { db, group } = await setup({ autoPush: true, derive })
    await group.collection('invoices').put('i1', { id: 'acme', amount: 10 } as never)
    await group.collection('invoices').put('i2', { id: 'globex', amount: 20 } as never)
    await group.whenInsightsSettled()
    expect(await readSummary(db, 'acme')).toMatchObject({ total: 10 })
    expect(await readSummary(db, 'globex')).toMatchObject({ total: 20 })
  })
})

describe('VaultGroup — auto-push debounce (#13)', () => {
  it('debounce batches a multi-tick burst into ONE derive', async () => {
    const derive = makeDerive()
    const { db, group } = await setup({ autoPush: { debounceMs: 40 }, derive })
    // three writes spread across macrotasks, each gap < debounceMs → one batched flush
    await group.collection('invoices').put('i1', { id: 'acme', amount: 1 } as never)
    await new Promise((r) => setTimeout(r, 10))
    await group.collection('invoices').put('i2', { id: 'acme', amount: 2 } as never)
    await new Promise((r) => setTimeout(r, 10))
    await group.collection('invoices').put('i3', { id: 'acme', amount: 3 } as never)
    await group.whenInsightsSettled()
    expect(derive).toHaveBeenCalledTimes(1) // batched — microtask-only would be 3
    expect(await readSummary(db, 'acme')).toMatchObject({ count: 3, total: 6 })
  })

  it('debounce separates writes beyond the window into distinct derives', async () => {
    const derive = makeDerive()
    const { db, group } = await setup({ autoPush: { debounceMs: 20 }, derive })
    await group.collection('invoices').put('i1', { id: 'acme', amount: 1 } as never)
    await group.whenInsightsSettled()
    await group.collection('invoices').put('i2', { id: 'acme', amount: 2 } as never)
    await group.whenInsightsSettled()
    expect(derive).toHaveBeenCalledTimes(2)
    expect(await readSummary(db, 'acme')).toMatchObject({ count: 2, total: 3 })
  })
})

describe('VaultGroup — auto-push minVersion gating (#13)', () => {
  it('does NOT push a summary for a shard behind minVersion', async () => {
    const derive = makeDerive()
    // template is v1; minVersion 2 → the v1 shard is gated out
    const { db, group } = await setup({ autoPush: { minVersion: 2 }, derive })
    await group.collection('invoices').put('i1', { id: 'acme', amount: 100 } as never)
    await group.whenInsightsSettled()
    expect(await readSummary(db, 'acme')).toBeFalsy() // gated — nothing pushed
  })

  it('pushes a summary for a shard at or above minVersion', async () => {
    const derive = makeDerive()
    // template is v1; minVersion 1 → the v1 shard passes (1 >= 1)
    const { db, group } = await setup({ autoPush: { minVersion: 1 }, derive })
    await group.collection('invoices').put('i1', { id: 'acme', amount: 100 } as never)
    await group.whenInsightsSettled()
    expect(await readSummary(db, 'acme')).toMatchObject({ count: 1, total: 100 })
  })
})

describe('InsightAutoPush — debounce single-flight (#13)', () => {
  it('a write during a slow recompute does not spawn a concurrent flush; whenSettled waits for both, in order', async () => {
    const recomputed: string[] = []
    let releaseA: (() => void) | null = null
    const recompute = async (pk: string) => {
      if (pk === 'a') await new Promise<void>((r) => { releaseA = r }) // 'a' blocks until released
      recomputed.push(pk)
    }
    const ctrl = new InsightAutoPush(recompute, () => true, () => {}, 10)
    ctrl.noteWrite('a', 'invoices')
    await new Promise((r) => setTimeout(r, 20)) // timer fires → runFlush#1 starts, awaits on 'a'
    ctrl.noteWrite('b', 'invoices')             // mid-flush write — must NOT start a concurrent flush
    await new Promise((r) => setTimeout(r, 20)) // a 2nd timer would fire here without the guard
    releaseA!()                                  // let 'a' finish
    await ctrl.whenSettled()
    expect(recomputed).toEqual(['a', 'b'])       // single-flight + ordered; buggy code yields ['b','a'] / early settle
  })
})
