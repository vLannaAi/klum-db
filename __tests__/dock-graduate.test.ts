import { describe, it, expect } from 'vitest'
import { createNoydb, isDeedVault, MemorySealingKeyProvider } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'
import { createLobby } from '../src/index.js'
import { InMemoryUnitDriver } from '../src/dock/unit-driver.js'
import { MigrationTransformRequiredError } from '../src/interchange/stage-records.js'
import { UnitGraduationError } from '../src/dock/graduate.js'
import type { VaultTemplate } from '../src/federation/index.js'

async function lobby() {
  const db = await createNoydb({ store: memory(), user: 'firm', secret: 'firm-secret-123' })
  return { db, lob: createLobby(db) }
}

const template: VaultTemplate = {
  version: 1,
  configure: (v) => {
    v.collection('clients')
    v.collection('invoices')
  },
}

const driver = () =>
  new InMemoryUnitDriver('legacy-1', {
    clients: [{ id: '1', name: 'Acme' }, { id: '2', name: 'Globex' }],
    invoices: [{ id: 'i1', clientId: '1', total: '1200.00' }],
  })

describe('Lobby.graduate — foreign unit → sovereign vault', () => {
  it('imports all foreign collections into a fresh vault and reports counts', async () => {
    const { db, lob } = await lobby()
    const report = await lob.graduate(lob.dock(driver()), { vaultName: 'acme', template })

    expect(report.vaultName).toBe('acme')
    expect(report.collections.clients.graduated).toBe(2)
    expect(report.collections.invoices.graduated).toBe(1)
    expect(report.event).toEqual({ type: 'unit-graduated', unitId: 'legacy-1', vault: 'acme' })

    // The records are readable via the REAL sovereign vault API.
    const vault = await db.openVault('acme')
    expect(await vault.collection('clients').get('1')).toMatchObject({ id: '1', name: 'Acme' })
    expect(await vault.collection('invoices').get('i1')).toMatchObject({ id: 'i1', total: '1200.00' })
  })

  it('applies a per-collection mapping transform (foreign shape → target)', async () => {
    const { db, lob } = await lobby()
    const foreign = new InMemoryUnitDriver('legacy-2', { clients: [{ id: '1', full_name: 'Acme Co' }] })
    await lob.graduate(lob.dock(foreign), {
      vaultName: 'acme2',
      template,
      mapping: { clients: (row) => ({ id: row.id, name: row.full_name }) },
    })
    const vault = await db.openVault('acme2')
    expect(await vault.collection('clients').get('1')).toMatchObject({ id: '1', name: 'Acme Co' })
  })

  it('renames collections via collectionMap', async () => {
    const { db, lob } = await lobby()
    const foreign = new InMemoryUnitDriver('legacy-3', { tbl_clients: [{ id: '1', name: 'A' }] })
    await lob.graduate(lob.dock(foreign), {
      vaultName: 'acme3',
      template,
      collectionMap: { tbl_clients: 'clients' },
    })
    const vault = await db.openVault('acme3')
    expect(await vault.collection('clients').get('1')).toMatchObject({ id: '1', name: 'A' })
  })

  it('staging-safety: a record failing target validation aborts; vault stays empty', async () => {
    const { db, lob } = await lobby()
    const strictTemplate: VaultTemplate = {
      version: 1,
      configure: (v) =>
        v.collection('clients', {
          schema: { parse: (val: any) => { if (typeof val.name !== 'string') throw new Error('name required'); return val } } as any,
        }),
    }
    const bad = new InMemoryUnitDriver('legacy-4', { clients: [{ id: '1', name: 123 }] })
    await expect(
      lob.graduate(lob.dock(bad), { vaultName: 'acme4', template: strictTemplate }),
    ).rejects.toBeInstanceOf(MigrationTransformRequiredError)

    const vault = await db.openVault('acme4')
    // noy-db returns null (not undefined) for missing records; either signals "not written"
    expect(await vault.collection('clients').get('1')).toBeFalsy()
  })

  it('refuses to graduate into an existing non-empty vault', async () => {
    const { db, lob } = await lobby()
    const seeded = await db.openVault('taken')
    await seeded.collection('clients').put('x', { id: 'x', name: 'pre-existing' })
    await expect(
      lob.graduate(lob.dock(driver()), { vaultName: 'taken', template }),
    ).rejects.toThrow(/already exists|not empty/i)
  })
})

describe('Lobby.graduate — null/absent foreign id guard', () => {
  it('rejects with UnitGraduationError when a row in a foreign collection has no id', async () => {
    const { lob } = await lobby()
    const foreign = new InMemoryUnitDriver('legacy-null-id', {
      clients: [{ id: '1', name: 'Acme' }, { name: 'NoId' }],
    })
    await expect(
      lob.graduate(lob.dock(foreign), { vaultName: 'acme-null-id', template }),
    ).rejects.toBeInstanceOf(UnitGraduationError)
  })
})

describe('Lobby.graduate — sovereign tier unlock', () => {
  it('seals a Deed when opts.deed is provided (custody tier)', async () => {
    const { db, lob } = await lobby()
    const sealing = new MemorySealingKeyProvider({ id: 'client-sealer' })
    const report = await lob.graduate(lob.dock(driver()), {
      vaultName: 'acme-deed',
      template,
      deed: { ownerId: 'client-acme', sealingProvider: sealing },
    })
    expect(report.deedSealed).toBe(true)
    expect(await isDeedVault(db._store, 'acme-deed')).toBe(true)
  })

  it('does NOT seal a Deed by default', async () => {
    const { db, lob } = await lobby()
    const report = await lob.graduate(lob.dock(driver()), { vaultName: 'acme-nodeed', template })
    expect(report.deedSealed).toBe(false)
    expect(await isDeedVault(db._store, 'acme-nodeed')).toBe(false)
  })

  it('records an audited unit-graduated event when a stateVault is supplied', async () => {
    const { lob } = await lobby()
    const stateVault = await lob.openStateManagementVault()
    await lob.graduate(lob.dock(driver()), { vaultName: 'acme-audit', template, stateVault })
    const events = await stateVault.queryEvents().toArray()
    const grad = events.find((e) => e.type === 'unit-graduated')
    expect(grad).toBeDefined()
    expect(grad?.vaultId).toBe('acme-audit')
    expect(grad?.detail).toContain('legacy-1')
  })
})
