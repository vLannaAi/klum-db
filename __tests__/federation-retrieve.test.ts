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
})
