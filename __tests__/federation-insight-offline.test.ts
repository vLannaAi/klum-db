/**
 * Insight Vault — offline (backend-unreachable) shard consistency (#3).
 * Resilience (skip-and-continue / failFast) + targeted catch-up.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '@noy-db/hub'
import { ConflictError, createNoydb } from '@noy-db/hub'
import type { Vault } from '@noy-db/hub'
import type { VaultRegistryRow } from '../src/federation/index.js'
import { createLobby } from '../src/index.js'

interface Inv extends Record<string, unknown> { id: string; clientId: string; amount: number; status: string }
interface Summary extends Record<string, unknown> { clientId: string; total: number }

/** In-memory store whose ops throw for any compartment id in `downed` (simulated unreachable backend). */
function faultable(downed: Set<string>): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const gc = (c: string, col: string) => {
    let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  const guard = (c: string) => { if (downed.has(c)) throw new Error('backend unreachable: ' + c) }
  return {
    name: 'memory',
    async get(c, col, id) { guard(c); return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) { guard(c); const coll = gc(c, col); const ex = coll.get(id); if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v); coll.set(id, env) },
    async delete(c, col, id) { guard(c); store.get(c)?.get(col)?.delete(id) },
    async list(c, col) { guard(c); const coll = store.get(c)?.get(col); return coll ? [...coll.keys()] : [] },
    async loadAll(c) { guard(c); const comp = store.get(c); const s: VaultSnapshot = {}; if (comp) for (const [n, coll] of comp) { if (!n.startsWith('_')) { const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of coll) r[id] = e; s[n] = r } } return s },
    async saveAll(c, data) { guard(c); for (const [n, recs] of Object.entries(data)) { const coll = gc(c, n); for (const [id, e] of Object.entries(recs)) coll.set(id, e) } },
  }
}

async function harness() {
  const downed = new Set<string>()
  const db = await createNoydb({ store: faultable(downed), user: 'operator', secret: 'op-pass' })
  const lobby = createLobby(db)
  lobby.withVaultTemplate('t', { version: 1, configure(v: Vault) { v.collection<Inv>('invoices') } })
  const registry = (await db.openVault('state')).collection<VaultRegistryRow>('vault-registry')
  const firm = await lobby.openVaultGroup<Inv>('firm-clients', {
    registry, sharding: { keyOf: (r) => r.clientId, vaultTemplate: 't', autoCreate: true },
  })
  const registerSummary = () => firm.withCrossVaultDerivation<Inv, Summary>({
    source: 'invoices', target: { vault: 'firm-insights', collection: 'client-summary' },
    derive: (recs, ctx) => ({ clientId: ctx.partitionKey, total: recs.reduce((s, r) => s + r.amount, 0) }),
  })
  const summaries = async () => (await db.openVault('firm-insights')).collection<Summary>('client-summary')
  return { db, firm, downed, registerSummary, summaries }
}

describe('Insight Vault — offline-shard consistency (#3)', () => {
  let h: Awaited<ReturnType<typeof harness>>
  beforeEach(async () => {
    h = await harness()
    const inv = h.firm.collection<Inv>('invoices')
    await inv.put('a1', { id: 'a1', clientId: 'acme', amount: 100, status: 'paid' })
    await inv.put('b1', { id: 'b1', clientId: 'globex', amount: 50, status: 'paid' })
    h.registerSummary()
  })

  it('one unreachable shard does not sink the others (skip-and-continue, no throw)', async () => {
    await h.firm.refreshInsights() // both summaries good
    h.downed.add('firm-clients--acme') // acme backend goes offline

    const res = await h.firm.refreshInsights() // must NOT throw
    expect(res.written).toBe(1) // globex still refreshed
    expect(res.skippedVaults.map((s) => s.vaultId)).toEqual(['firm-clients--acme'])
    expect(res.skippedVaults[0]!.reason).toBe('error')
  })

  it('failFast: true re-throws on the first unreachable shard', async () => {
    await h.firm.refreshInsights()
    h.downed.add('firm-clients--acme')
    await expect(h.firm.refreshInsights({ failFast: true })).rejects.toThrow('backend unreachable')
  })

  it('a skipped shard keeps its prior summary untouched', async () => {
    await h.firm.refreshInsights()
    expect((await (await h.summaries()).get('acme'))?.total).toBe(100)
    h.downed.add('firm-clients--acme')
    await h.firm.refreshInsights() // acme skipped
    // prior summary still there, not deleted / emptied
    expect((await (await h.summaries()).get('acme'))?.total).toBe(100)
  })

  it('only: restricts the refresh to the named shards', async () => {
    const inv = h.firm.collection<Inv>('invoices')
    await inv.put('a2', { id: 'a2', clientId: 'acme', amount: 25, status: 'paid' })
    await inv.put('b2', { id: 'b2', clientId: 'globex', amount: 25, status: 'paid' })
    const res = await h.firm.refreshInsights({ only: ['acme'] })
    expect(res.written).toBe(1)
    const s = await h.summaries()
    expect((await s.get('acme'))?.total).toBe(125) // refreshed
    expect(await s.get('globex')).toBeNull() // never touched
  })

  it('only: an unknown partition key is a no-op (no throw)', async () => {
    const res = await h.firm.refreshInsights({ only: ['does-not-exist'] })
    expect(res).toEqual({ written: 0, skippedVaults: [] })
  })

  it('refreshDerivation reconciles one shard after reconnect (covers a non-autoPush derivation)', async () => {
    await h.firm.refreshInsights()
    // acme goes down, more invoices land elsewhere; acme summary lags
    h.downed.add('firm-clients--acme')
    await h.firm.collection<Inv>('invoices').put('b2', { id: 'b2', clientId: 'globex', amount: 200, status: 'paid' })
    await h.firm.refreshInsights() // globex updated to 250, acme skipped (still 100)
    expect((await (await h.summaries()).get('globex'))?.total).toBe(250)

    // acme reconnects; targeted catch-up — derivation was registered WITHOUT autoPush
    h.downed.delete('firm-clients--acme')
    await h.firm.collection<Inv>('invoices').put('a2', { id: 'a2', clientId: 'acme', amount: 5, status: 'paid' })
    const res = await h.firm.refreshDerivation('acme')
    expect(res.written).toBe(1)
    expect(res.skippedVaults).toEqual([])
    const s = await h.summaries()
    expect((await s.get('acme'))?.total).toBe(105) // reconciled
    expect((await s.get('globex'))?.total).toBe(250) // untouched by the targeted call
  })

  it('refreshDerivation re-reports a still-unreachable shard without throwing', async () => {
    await h.firm.refreshInsights()
    h.downed.add('firm-clients--acme')
    const res = await h.firm.refreshDerivation('acme')
    expect(res.written).toBe(0)
    expect(res.skippedVaults.map((v) => v.vaultId)).toEqual(['firm-clients--acme'])
  })

  it('C1: only with a valid pk AND unknown pk — only the valid shard is refreshed, no throw', async () => {
    const res = await h.firm.refreshInsights({ only: ['acme', 'does-not-exist'] })
    expect(res.written).toBe(1)
    expect(res.skippedVaults).toEqual([])
    const s = await h.summaries()
    expect((await s.get('acme'))?.total).toBe(100)
    expect(await s.get('globex')).toBeNull()
  })

  it('C2: only shard below minVersion is skipped as schema-drift', async () => {
    // The harness uses template version 1; both acme and globex are at schemaVersion 1.
    // Asking minVersion: 2 with only: ['acme'] must skip acme as schema-drift.
    const res = await h.firm.refreshInsights({ only: ['acme'], minVersion: 2 })
    expect(res.written).toBe(0)
    const skipped = res.skippedVaults.find((s) => s.vaultId === 'firm-clients--acme')
    expect(skipped).toBeDefined()
    expect(skipped!.reason).toBe('schema-drift')
    // Summary must NOT have been written
    const s = await h.summaries()
    expect(await s.get('acme')).toBeNull()
  })

  it('C3: refreshDerivation then full refreshInsights — identical summary, single row per pk', async () => {
    // Targeted catch-up first
    const r1 = await h.firm.refreshDerivation('acme')
    expect(r1.written).toBe(1)
    const s1 = await h.summaries()
    const acmeSummaryBefore = await s1.get('acme')
    expect(acmeSummaryBefore).not.toBeNull()

    // Full refresh
    const r2 = await h.firm.refreshInsights()
    expect(r2.written).toBe(2) // both shards written
    const s2 = await h.summaries()
    const acmeSummaryAfter = await s2.get('acme')
    expect(acmeSummaryAfter).toEqual(acmeSummaryBefore) // identical value
  })
})

// ---------------------------------------------------------------------------
// Selective read-site failure (FINDING B): a store that fails list() for one
// specific compartment+collection so the error surfaces inside the fan-out
// callback (res.error branch), not at the provisioning probe.
// ---------------------------------------------------------------------------

describe('Insight Vault — read-site fan-out failure (selective list() injection)', () => {
  async function readSiteHarness() {
    const base: NoydbStore = (() => {
      const store = new Map<string, Map<string, Map<string, import('@noy-db/hub').EncryptedEnvelope>>>()
      const gc = (c: string, col: string) => {
        let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
        let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
        return coll
      }
      return {
        name: 'memory',
        async get(c: string, col: string, id: string) { return store.get(c)?.get(col)?.get(id) ?? null },
        async put(c: string, col: string, id: string, env: import('@noy-db/hub').EncryptedEnvelope, ev?: number) {
          const { ConflictError: CE } = await import('@noy-db/hub')
          const coll = gc(c, col); const ex = coll.get(id)
          if (ev !== undefined && ex && ex._v !== ev) throw new CE(ex._v)
          coll.set(id, env)
        },
        async delete(c: string, col: string, id: string) { store.get(c)?.get(col)?.delete(id) },
        async list(c: string, col: string) { const coll = store.get(c)?.get(col); return coll ? [...coll.keys()] : [] },
        async loadAll(c: string) {
          const comp = store.get(c); const s: import('@noy-db/hub').VaultSnapshot = {}
          if (comp) for (const [n, coll] of comp) {
            if (!n.startsWith('_')) {
              const r: Record<string, import('@noy-db/hub').EncryptedEnvelope> = {}
              for (const [id, e] of coll) r[id] = e
              s[n] = r
            }
          }
          return s
        },
        async saveAll(c: string, data: import('@noy-db/hub').VaultSnapshot) {
          for (const [n, recs] of Object.entries(data)) {
            const coll = gc(c, n)
            for (const [id, e] of Object.entries(recs)) coll.set(id, e as import('@noy-db/hub').EncryptedEnvelope)
          }
        },
      }
    })()

    let failBigcoRead = false
    const adapter: NoydbStore = {
      ...base,
      async list(c: string, col: string) {
        if (failBigcoRead && c === 'firm-clients--bigco' && col === 'invoices') {
          throw new Error('injected read failure for bigco/invoices')
        }
        return base.list(c, col)
      },
    }

    const tmpl = (vault: Vault) => { vault.collection<Inv>('invoices') }

    // --- write side ---
    const wdb = await createNoydb({ store: adapter, user: 'operator', secret: 'op-pass' })
    const wlobby = createLobby(wdb)
    wlobby.withVaultTemplate('t', { version: 1, configure: tmpl })
    const wState = await wdb.openVault('state')
    const wFirm = await wlobby.openVaultGroup<Inv>('firm-clients', {
      registry: wState.collection<VaultRegistryRow>('vault-registry'),
      sharding: { keyOf: (r) => r.clientId, vaultTemplate: 't', autoCreate: true },
    })
    await wFirm.collection('invoices').put('a1', { id: 'a1', clientId: 'acme', amount: 100, status: 'paid' })
    await wFirm.collection('invoices').put('b1', { id: 'b1', clientId: 'bigco', amount: 200, status: 'paid' })

    // --- read side: fresh db, empty caches ---
    failBigcoRead = true
    const rdb = await createNoydb({ store: adapter, user: 'operator', secret: 'op-pass' })
    const rlobby = createLobby(rdb)
    rlobby.withVaultTemplate('t', { version: 1, configure: tmpl })
    const rState = await rdb.openVault('state')
    const rFirm = await rlobby.openVaultGroup<Inv>('firm-clients', {
      registry: rState.collection<VaultRegistryRow>('vault-registry'),
      sharding: { keyOf: (r) => r.clientId, vaultTemplate: 't', autoCreate: true },
    })
    rFirm.withCrossVaultDerivation<Inv, Summary>({
      source: 'invoices', target: { vault: 'firm-insights', collection: 'client-summary' },
      derive: (recs, ctx) => ({ clientId: ctx.partitionKey, total: recs.reduce((s, r) => s + r.amount, 0) }),
    })
    const summaries = async () => (await rdb.openVault('firm-insights')).collection<Summary>('client-summary')

    return { rFirm, summaries }
  }

  it('B1: selective list() failure — healthy shard written, failed shard in skippedVaults with reason error', async () => {
    const { rFirm, summaries } = await readSiteHarness()
    const res = await rFirm.refreshInsights()
    // acme's read is fine; bigco's list() throws → skipped
    expect(res.written).toBe(1)
    const skipped = res.skippedVaults.find((s) => s.vaultId === 'firm-clients--bigco')
    expect(skipped).toBeDefined()
    expect(skipped!.reason).toBe('error')
    expect(skipped!.error).toBeInstanceOf(Error)
    // Healthy shard's summary was written
    const s = await summaries()
    expect((await s.get('acme'))?.total).toBe(100)
    expect(await s.get('bigco')).toBeNull()
  })

  it('B2: selective list() failure + failFast: true — refreshInsights rejects', async () => {
    const { rFirm } = await readSiteHarness()
    await expect(rFirm.refreshInsights({ failFast: true })).rejects.toThrow('injected read failure for bigco/invoices')
  })
})
