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

  it('federationMeta() returns group meta + each member vault meta (round-trips getMeta)', async () => {
    const { db, group } = await makeGroup({ label: 'Firm Docs' })
    // give acme a vault meta on the SAME db BEFORE first put so first-wins caching retains it
    await db.openVault('firm-docs--acme', { meta: { label: 'Acme', icon: 'building' } } as never)
    // create two shards; acme reuses the cached vault (with meta), bigco gets none
    const docs = group.collection<Doc>('docs')
    await docs.put('a1', { shard: 'acme', body: 'x' })
    await docs.put('b1', { shard: 'bigco', body: 'y' })

    const fm = await group.federationMeta()
    expect(fm.meta).toEqual({ label: 'Firm Docs' })
    const acme = fm.vaults.find((v) => v.vaultId === 'firm-docs--acme')
    const bigco = fm.vaults.find((v) => v.vaultId === 'firm-docs--bigco')
    expect(acme?.meta).toEqual({ label: 'Acme', icon: 'building' })
    expect(acme?.partitionKey).toBe('acme')
    expect(bigco?.meta).toBeUndefined() // opened without meta
  })

  it('federationMeta() is best-effort: an unprovisioned registry row → meta undefined, no throw', async () => {
    const { db, group } = await makeGroup()
    await group.collection<Doc>('docs').put('a1', { shard: 'acme', body: 'x' })
    // divergent registry row: points at a vault that was never provisioned
    const registry = (await db.openVault('state')).collection<VaultRegistryRow>('vault-registry')
    await registry.put('firm-docs--ghost', {
      vaultId: 'firm-docs--ghost', partitionKey: 'ghost',
      templateName: 't', schemaVersion: 1, createdAt: 1, group: 'firm-docs',
    } as never)

    const fm = await group.federationMeta() // must not throw
    const ghost = fm.vaults.find((v) => v.vaultId === 'firm-docs--ghost')
    expect(ghost).toBeDefined()
    expect(ghost?.meta).toBeUndefined()
  })
})
