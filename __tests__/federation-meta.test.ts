/** Federation metadata (#27) — group.meta + federationMeta(). */
import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot, Vault } from '@noy-db/hub'
import { ConflictError, createNoydb } from '@noy-db/hub'
import type { VaultRegistryRow } from '../src/federation/index.js'
import { createLobby } from '../src/index.js'

interface Doc extends Record<string, unknown> { shard: string; body: string }

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

async function makeGroup(meta?: { label?: string; description?: string; icon?: string }) {
  const db = await createNoydb({ store: memoryStore(), user: 'operator', secret: 'op-pass' })
  const lobby = createLobby(db)
  lobby.withVaultTemplate('t', { version: 1, configure(v: Vault) { v.collection<Doc>('docs') } })
  const registry = (await db.openVault('state')).collection<VaultRegistryRow>('vault-registry')
  const group = await lobby.openVaultGroup<Doc>('firm-docs', {
    registry, sharding: { keyOf: (r) => r.shard, vaultTemplate: 't', autoCreate: true },
    ...(meta ? { meta } : {}),
  })
  return { db, group }
}

describe('federation metadata (#27)', () => {
  it('group.meta returns the declared meta, or undefined when not given', async () => {
    const withMeta = await makeGroup({ label: 'Firm Docs', description: 'All client documents', icon: 'folder' })
    expect(withMeta.group.meta).toEqual({ label: 'Firm Docs', description: 'All client documents', icon: 'folder' })
    const without = await makeGroup()
    expect(without.group.meta).toBeUndefined()
  })
})
