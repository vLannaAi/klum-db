/**
 * Federation showcase — end-to-end narrated walkthrough of the federation layer.
 * Referenced by docs/federation.md. Exercises in sequence:
 *   1. VaultGroup + auto-create shards
 *   2. Fan-out query (ShardedQuery.toArray)
 *   3. Distributed aggregate (partial-reduce + groupBy)
 *   4. Co-partitioned crossShardJoin
 *   5. Insight Vault (withCrossVaultDerivation + refreshInsights)
 *   6. StateManagement Vault (manifest + registry inspection)
 */
import { describe, it, expect, beforeAll } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot, Vault } from '@noy-db/hub'
import { ConflictError, createNoydb } from '@noy-db/hub'
import { ref } from '@noy-db/hub'
import { sum, count } from '@noy-db/hub/aggregate'
import { createLobby } from '../src/index.js'
import type { VaultGroup, VaultRegistryRow } from '../src/index.js'

// ─── In-memory store (same pattern as all federation tests) ───────────────────

function memoryStore(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const gc = (c: string, col: string) => {
    let comp = store.get(c)
    if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col)
    if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    name: 'memory',
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = gc(c, col)
      const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) { const coll = store.get(c)?.get(col); return coll ? [...coll.keys()] : [] },
    async loadAll(c) {
      const comp = store.get(c)
      const s: VaultSnapshot = {}
      if (comp) for (const [n, coll] of comp) {
        if (!n.startsWith('_')) {
          const r: Record<string, EncryptedEnvelope> = {}
          for (const [id, e] of coll) r[id] = e
          s[n] = r
        }
      }
      return s
    },
    async saveAll(c, data) {
      for (const [n, recs] of Object.entries(data)) {
        const coll = gc(c, n)
        for (const [id, e] of Object.entries(recs)) coll.set(id, e)
      }
    },
  }
}

// ─── Domain types ─────────────────────────────────────────────────────────────

interface Invoice extends Record<string, unknown> {
  id: string
  clientId: string    // partition key — each value maps to one shard
  customerId: string
  amount: number
  status: string
}

interface Customer extends Record<string, unknown> {
  id: string
  name: string
}

interface ClientSummary extends Record<string, unknown> {
  partitionKey: string
  totalRevenue: number
  invoiceCount: number
}

// ─── Showcase ─────────────────────────────────────────────────────────────────

describe('Federation showcase', () => {
  let db: Awaited<ReturnType<typeof createNoydb>>
  let lobby: ReturnType<typeof createLobby>
  // assigned in beforeAll; non-null assertion avoids TypeScript "used before assigned"
  let group!: VaultGroup<Invoice>

  beforeAll(async () => {
    // ── § 1. Bootstrap ────────────────────────────────────────────────────────
    db = await createNoydb({ store: memoryStore(), user: 'operator', secret: 'op-pass' })
    lobby = createLobby(db)

    // ── § 2. VaultTemplate — schema blueprint stamped onto every shard.
    //        customers + invoices(ref customers) so crossShardJoin works later.
    lobby.withVaultTemplate('client-template', {
      version: 1,
      configure(vault: Vault) {
        vault.collection<Customer>('customers')
        vault.collection<Invoice>('invoices', { refs: { customerId: ref('customers') } })
      },
    })

    // ── § 3. openVaultGroup — no explicit registry: the StateManagement vault is
    //        auto-opened (STATE_VAULT_NAME), the schema manifest is recorded, and
    //        the group is attached to it.
    group = await lobby.openVaultGroup<Invoice>('firm-clients', {
      sharding: {
        keyOf: (r) => r.clientId,      // partition key extractor
        vaultTemplate: 'client-template',
        autoCreate: true,               // stamp a new shard inline on first write to an unknown key
      },
      meta: { label: 'Firm Clients' },  // descriptive; surfaced via group.meta / federationMeta()
    })

    // ── § 4. Seed two shards.
    //        createShard is called explicitly here because the `ref` constraint on
    //        'invoices' requires the referenced customer to exist in the same shard
    //        BEFORE the invoice is written (strict ref enforces integrity at write time).
    //        Shard vault ids:  firm-clients--acme,  firm-clients--bigco.
    const acmeShard = await group.createShard('acme')
    await acmeShard.collection<Customer>('customers').put('c-acme', { id: 'c-acme', name: 'Acme Corp' })

    const bigcoShard = await group.createShard('bigco')
    await bigcoShard.collection<Customer>('customers').put('c-bigco', { id: 'c-bigco', name: 'BigCo Ltd' })

    // ShardedCollection.put → keyOf(record) = record.clientId → routes to the owning shard.
    const inv = group.collection<Invoice>('invoices')
    await inv.put('a1', { id: 'a1', clientId: 'acme', customerId: 'c-acme', amount: 100, status: 'open' })
    await inv.put('a2', { id: 'a2', clientId: 'acme', customerId: 'c-acme', amount: 250, status: 'overdue' })
    await inv.put('b1', { id: 'b1', clientId: 'bigco', customerId: 'c-bigco', amount: 300, status: 'open' })
  })

  // ── § 1 — VaultGroup + shard registry ──────────────────────────────────────

  describe('1 — VaultGroup + shard registry', () => {
    it('provisioned shards appear in the registry with group-scoped vault ids', async () => {
      const rows = await group.allRows()
      expect(rows.map((r) => r.partitionKey).sort()).toEqual(['acme', 'bigco'])
      // Vault id = "${groupName}--${partitionKey}" (the SHARD_SEPARATOR is '--').
      expect(rows.find((r) => r.partitionKey === 'acme')?.vaultId).toBe('firm-clients--acme')
      expect(rows.every((r) => r.group === 'firm-clients')).toBe(true)
    })

    it('group.meta carries the declared descriptive metadata', () => {
      expect(group.meta).toEqual({ label: 'Firm Clients' })
    })
  })

  // ── § 2 — Fan-out query ─────────────────────────────────────────────────────

  describe('2 — fan-out query (ShardedQuery.toArray)', () => {
    it('where().toArray() fans out across both shards and unions filtered records', async () => {
      const { results, skippedVaults } = await group
        .collection<Invoice>('invoices')
        .query()
        .where('status', '==', 'open')
        .toArray()

      expect(skippedVaults).toEqual([])
      // a1 (acme, open) + b1 (bigco, open) — a2 (overdue) excluded.
      expect(results.map((r: Invoice) => r.id).sort()).toEqual(['a1', 'b1'])
    })

    it('unfiltered toArray() returns all records across both shards', async () => {
      const { results } = await group.collection<Invoice>('invoices').query().toArray()
      expect(results).toHaveLength(3)
    })
  })

  // ── § 3 — Distributed aggregate ─────────────────────────────────────────────

  describe('3 — distributed aggregate', () => {
    it('aggregate({ total: sum, n: count }) uses distributed partial-reduce (no row union materialized)', async () => {
      // sum and count both expose `merge` → canPartialReduce returns true.
      // Each shard folds its own records to a PartialState (partial-reduce.ts:33).
      // Central merge (partial-reduce.ts:49) + finalize (partial-reduce.ts:61).
      const { result, skippedVaults } = await group
        .collection<Invoice>('invoices')
        .query()
        .aggregate({ total: sum('amount'), n: count() })
        .run()

      expect(skippedVaults).toEqual([])
      // acme: 100 + 250 = 350;  bigco: 300  →  total 650, n 3
      expect(result.total).toBe(650)
      expect(result.n).toBe(3)
    })

    it('groupBy().aggregate() groups across shard boundaries via central reduce', async () => {
      const { results } = await group
        .collection<Invoice>('invoices')
        .query()
        .groupBy('status')
        .aggregate({ total: sum('amount'), n: count() })
        .run()

      const byStatus = Object.fromEntries(results.map((r: any) => [r.status as string, r]))
      expect(byStatus['open'].total).toBe(400)    // 100 (acme a1) + 300 (bigco b1)
      expect(byStatus['overdue'].total).toBe(250) // 250 (acme a2 only)
    })
  })

  // ── § 4 — Co-partitioned crossShardJoin ─────────────────────────────────────

  describe('4 — co-partitioned crossShardJoin', () => {
    it('each shard joins its own right collection; results are unioned centrally', async () => {
      // crossShardJoin('customerId', { as: 'customer' }) → each shard runs intra-vault
      // .join('customerId') against its local customers collection (resolved via ref()),
      // then all joined rows are unioned. Requires a ref() declaration on the template.
      const { results, skippedVaults } = await group
        .collection<Invoice>('invoices')
        .query()
        .crossShardJoin('customerId', { as: 'customer' })
        .toArray()

      expect(skippedVaults).toEqual([])
      const byId: Record<string, any> = Object.fromEntries(
        results.map((r: any) => [r.id as string, r]),
      )
      expect(byId['a1'].customer.name).toBe('Acme Corp')
      expect(byId['a2'].customer.name).toBe('Acme Corp')
      expect(byId['b1'].customer.name).toBe('BigCo Ltd')
    })
  })

  // ── § 5 — Insight Vault ──────────────────────────────────────────────────────

  describe('5 — Insight Vault (withCrossVaultDerivation + refreshInsights)', () => {
    it('writes one summary row per shard into a separate analytics vault', async () => {
      // Register a derivation: for each eligible shard, read its 'invoices' collection,
      // derive a ClientSummary, and write it into 'firm-insights' / 'client-summary'.
      // target.vault must not be the group or any of its shards — that would breach
      // the per-shard DEK boundary (ValidationError thrown at registration).
      group.withCrossVaultDerivation<Invoice, ClientSummary>({
        source: 'invoices',
        target: { vault: 'firm-insights', collection: 'client-summary' },
        derive: (records, ctx) => ({
          partitionKey: ctx.partitionKey,
          totalRevenue: records.reduce((s, r) => s + r.amount, 0),
          invoiceCount: records.length,
        }),
        // autoPush: true,  // optional: auto-derive on every write to source collection
      })

      const { written, skippedVaults } = await group.refreshInsights()
      expect(skippedVaults).toEqual([])
      expect(written).toBe(2) // one row per eligible shard

      // The Insight Vault is a SEPARATE vault — raw invoice ciphertext never crossed its DEK.
      const insightVault = await db.openVault('firm-insights')
      const summaries = insightVault.collection<ClientSummary>('client-summary')
      const acme = await summaries.get('acme')
      expect(acme?.totalRevenue).toBe(350)  // 100 + 250
      expect(acme?.invoiceCount).toBe(2)
      const bigco = await summaries.get('bigco')
      expect(bigco?.totalRevenue).toBe(300)
      expect(bigco?.invoiceCount).toBe(1)
    })
  })

  // ── § 6 — StateManagement Vault ──────────────────────────────────────────────

  describe('6 — StateManagement Vault (control plane)', () => {
    it('records the schema manifest when openVaultGroup is called', async () => {
      // openVaultGroup without an explicit registry opens STATE_VAULT_NAME and records
      // a fingerprinted blueprint of the template at the declared version.
      const sv = await lobby.openStateManagementVault()
      // Key format: "${templateName}:${version}"
      const manifest = await sv.schemaManifest.get('client-template:1')
      expect(manifest?.templateName).toBe('client-template')
      expect(manifest?.version).toBe(1)
      expect(manifest?.collections.slice().sort()).toEqual(['customers', 'invoices'])
    })

    it('vaultRegistry tracks every provisioned shard with its group, vaultId and schemaVersion', async () => {
      const sv = await lobby.openStateManagementVault()
      await sv.registry.list()
      const rows = sv.registry
        .query()
        .toArray()
        .filter((r: VaultRegistryRow) => r.group === 'firm-clients')
      expect(rows.map((r: VaultRegistryRow) => r.partitionKey).sort()).toEqual(['acme', 'bigco'])
      expect(rows.every((r: VaultRegistryRow) => r.schemaVersion === 1)).toBe(true)
    })
  })
})
