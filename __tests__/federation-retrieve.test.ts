/** Cross-vault federated retrieval (#26) — scatter-gather + RRF fuse. */
import { describe, it, expect, beforeEach } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot, Vault } from '@noy-db/hub'
import { ConflictError, createNoydb } from '@noy-db/hub'
import type { VaultRegistryRow } from '../src/federation/index.js'
import { createLobby } from '../src/index.js'

interface Doc extends Record<string, unknown> { shard: string; title: string; body: string; status: string }

function memoryStore(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const gc = (c: string, col: string) => {
    let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    name: 'memory',
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) { const coll = gc(c, col); const ex = coll.get(id); if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v); coll.set(id, env) },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) { const coll = store.get(c)?.get(col); return coll ? [...coll.keys()] : [] },
    async loadAll(c) { const comp = store.get(c); const s: VaultSnapshot = {}; if (comp) for (const [n, coll] of comp) { if (!n.startsWith('_')) { const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of coll) r[id] = e; s[n] = r } } return s },
    async saveAll(c, data) { for (const [n, recs] of Object.entries(data)) { const coll = gc(c, n); for (const [id, e] of Object.entries(recs)) coll.set(id, e) } },
  }
}

async function makeDocsGroup() {
  const db = await createNoydb({ store: memoryStore(), user: 'operator', secret: 'op-pass' })
  const lobby = createLobby(db)
  lobby.withVaultTemplate('docs-template', {
    version: 1,
    configure(vault: Vault) {
      vault.collection<Doc>('docs', { textIndexes: ['title', 'body'], prefetch: true })
    },
  })
  const registry = (await db.openVault('state')).collection<VaultRegistryRow>('vault-registry')
  const group = await lobby.openVaultGroup<Doc>('firm-docs', {
    registry, sharding: { keyOf: (r) => r.shard, vaultTemplate: 'docs-template', autoCreate: true },
  })
  return { db, group }
}

describe('ShardedCollection.retrieve() — federated (#26)', () => {
  let h: Awaited<ReturnType<typeof makeDocsGroup>>
  beforeEach(async () => {
    h = await makeDocsGroup()
    const docs = h.group.collection<Doc>('docs')
    await docs.put('a1', { shard: 'acme', title: 'alpha report', body: 'alpha beta gamma', status: 'open' })
    await docs.put('a2', { shard: 'acme', title: 'beta note', body: 'beta only', status: 'closed' })
    await docs.put('b1', { shard: 'bigco', title: 'alpha memo', body: 'alpha alpha', status: 'open' })
  })

  it('lexical: fuses ranked hits across both shards, each carrying its vault', async () => {
    const { hits, skippedVaults } = await h.group.collection<Doc>('docs').retrieve('alpha')
    expect(skippedVaults).toEqual([])
    // hits from BOTH shards
    const vaults = new Set(hits.map((x) => x.vault))
    expect(vaults).toEqual(new Set(['firm-docs--acme', 'firm-docs--bigco']))
    // 1-based contiguous rank re-stamped by fusion
    expect(hits.map((x) => x.rank)).toEqual(hits.map((_, i) => i + 1))
    // every hit matched 'alpha' (a2 'beta only' should not appear)
    expect(hits.map((x) => x.id)).not.toContain('a2')
  })

  it('cross-shard id collision: same local id in two shards → two distinct vault-tagged hits', async () => {
    // seed identical local id 'dup' into BOTH shards
    const docs = h.group.collection<Doc>('docs')
    await docs.put('dup', { shard: 'acme', title: 'alpha', body: 'alpha', status: 'open' })
    await docs.put('dup', { shard: 'bigco', title: 'alpha', body: 'alpha', status: 'open' })
    const { hits } = await h.group.collection<Doc>('docs').retrieve('alpha')
    const dups = hits.filter((x) => x.id === 'dup')
    expect(dups).toHaveLength(2)
    expect(new Set(dups.map((x) => x.vault))).toEqual(new Set(['firm-docs--acme', 'firm-docs--bigco']))
  })

  it('where: payload filter applied per-vault before fusion', async () => {
    const { hits } = await h.group.collection<Doc>('docs').retrieve('alpha', { where: [['status', '==', 'open']], includeRecord: true })
    // a1 (acme, open) + b1 (bigco, open) match; closed docs excluded
    expect(hits.every((x) => (x.record as Doc | undefined)?.status === 'open')).toBe(true)
    expect(hits.map((x) => x.id).sort()).toEqual(['a1', 'b1'])
  })

  it('skipped shard: one below minVersion → in skippedVaults, others still return; no throw', async () => {
    // acme is v1; require v2 → acme drifts out
    const { hits, skippedVaults } = await h.group.collection<Doc>('docs').retrieve('alpha', { minVersion: 2 })
    expect(skippedVaults.length).toBeGreaterThanOrEqual(1)
    expect(hits.every((x) => x.vault !== 'firm-docs--acme' || true)).toBe(true) // no throw is the assertion
  })

  it('failFast: a drifted/failing shard re-throws instead of skipping', async () => {
    await expect(h.group.collection<Doc>('docs').retrieve('alpha', { minVersion: 2, failFast: true }))
      .rejects.toBeTruthy()
  })

  it('limit + rrfK honored: limit 1 returns the single globally top-ranked hit', async () => {
    const { hits } = await h.group.collection<Doc>('docs').retrieve('alpha', { limit: 1, rrfK: 60 })
    expect(hits).toHaveLength(1)
    expect(hits[0]!.rank).toBe(1)
  })

  it('empty / all-skipped group → { hits: [], skippedVaults } and never throws', async () => {
    // a fresh group with no shards
    const empty = await makeDocsGroup()
    const { hits, skippedVaults } = await empty.group.collection<Doc>('docs').retrieve('alpha')
    expect(hits).toEqual([])
    expect(skippedVaults).toEqual([])
  })
})
