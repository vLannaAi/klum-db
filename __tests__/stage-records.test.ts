import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'
import type { DecryptedRecord } from '@noy-db/hub/bundle'
import { stageAndValidate, MigrationTransformRequiredError } from '../src/interchange/stage-records.js'

function rec(id: string, record: Record<string, unknown>): DecryptedRecord {
  return { id, record, ts: '2026-01-01T00:00:00.000Z', version: 1 }
}

async function freshVault() {
  const db = await createNoydb({ store: memory(), user: 'u', secret: 'secret-abc-123' })
  return db.openVault('v')
}

describe('stageAndValidate', () => {
  it('applies transforms in order and re-injects the canonical id', async () => {
    const vault = await freshVault()
    vault.collection('clients')
    const staged = await stageAndValidate(
      vault,
      { clients: [rec('c1', { name: 'a' })] },
      { clients: [(b) => ({ ...b, name: String(b.name).toUpperCase() }), (b) => ({ ...b, id: 'WRONG' })] },
    )
    expect(staged.clients[0].record).toEqual({ name: 'A', id: 'c1' }) // id re-injected, not 'WRONG'
  })

  it('passes through collections with no transform (additive)', async () => {
    const vault = await freshVault()
    vault.collection('clients')
    const staged = await stageAndValidate(vault, { clients: [rec('c1', { name: 'a' })] }, {})
    expect(staged.clients[0].record).toEqual({ name: 'a', id: 'c1' })
  })

  it('throws MigrationTransformRequiredError when a record fails the receiver schema', async () => {
    const vault = await freshVault()
    // collection with a schema requiring `total` as a string
    vault.collection('bills', { schema: { parse: (v: any) => { if (typeof v.total !== 'string') throw new Error('total must be string'); return v } } as any })
    await expect(
      stageAndValidate(vault, { bills: [rec('b1', { total: 123 })] }, {}),
    ).rejects.toBeInstanceOf(MigrationTransformRequiredError)
  })
})
