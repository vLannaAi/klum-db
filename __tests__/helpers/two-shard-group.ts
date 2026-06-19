/**
 * Shared test fixture: an in-memory operator db with a 2-shard VaultGroup.
 * Mirrors the harness in federation-vault-group.test.ts so the federation
 * tooling tests (group-inspector, meter-group, cli) exercise a real group.
 *
 * Shards after setup:
 *   firm-clients--acme  → invoices: a1, a2   (2 records)
 *   firm-clients--bigco → invoices: b1        (1 record)
 */
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot, Vault } from '@noy-db/hub'
import { ConflictError, createNoydb } from '@noy-db/hub'
import type { VaultRegistryRow } from '../../src/federation/index.js'
import { createLobby } from '../../src/index.js'

export interface Invoice {
  clientId: string
  amount: number
  status: string
}

export function memoryStore(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function gc(c: string, col: string) {
    let comp = store.get(c)
    if (!comp) {
      comp = new Map()
      store.set(c, comp)
    }
    let coll = comp.get(col)
    if (!coll) {
      coll = new Map()
      comp.set(col, coll)
    }
    return coll
  }
  return {
    name: 'memory',
    async get(c, col, id) {
      return store.get(c)?.get(col)?.get(id) ?? null
    },
    async put(c, col, id, env, ev) {
      const coll = gc(c, col)
      const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(c, col, id) {
      store.get(c)?.get(col)?.delete(id)
    },
    async list(c, col) {
      const coll = store.get(c)?.get(col)
      return coll ? [...coll.keys()] : []
    },
    async loadAll(c) {
      const comp = store.get(c)
      const s: VaultSnapshot = {}
      if (comp)
        for (const [n, coll] of comp) {
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

export async function makeTwoShardGroup() {
  const adapter = memoryStore()
  const db = await createNoydb({ store: adapter, user: 'operator', secret: 'op-pass' })
  const lobby = createLobby(db)
  lobby.withVaultTemplate('client-template', {
    version: 1,
    configure(vault: Vault) {
      vault.collection<Invoice>('invoices')
    },
  })
  const stateVault = await db.openVault('state')
  const registry = stateVault.collection<VaultRegistryRow>('vault-registry')
  const group = await lobby.openVaultGroup<Invoice>('firm-clients', {
    registry,
    sharding: { keyOf: (r) => r.clientId, vaultTemplate: 'client-template' },
  })
  const inv = group.collection('invoices')
  await inv.put('a1', { clientId: 'acme', amount: 100, status: 'open' })
  await inv.put('a2', { clientId: 'acme', amount: 200, status: 'open' })
  await inv.put('b1', { clientId: 'bigco', amount: 300, status: 'overdue' })
  return { db, registry, group }
}
