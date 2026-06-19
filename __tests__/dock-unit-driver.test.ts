import { describe, it, expect } from 'vitest'
import { InMemoryUnitDriver } from '../src/dock/unit-driver.js'

async function drain(it: AsyncIterable<Record<string, unknown>>) {
  const out: Record<string, unknown>[] = []
  for await (const r of it) out.push(r)
  return out
}

describe('InMemoryUnitDriver', () => {
  const driver = new InMemoryUnitDriver('legacy-sqlite-1', {
    clients: [{ id: '1', name: 'Acme' }, { id: '2', name: 'Globex' }],
    invoices: [{ id: 'i1', clientId: '1', total: 1200 }],
  })

  it('exposes a stable unitId', () => {
    expect(driver.unitId).toBe('legacy-sqlite-1')
  })

  it('lists the foreign collections', async () => {
    expect([...(await driver.listCollections())].sort()).toEqual(['clients', 'invoices'])
  })

  it('streams records for a collection', async () => {
    expect(await drain(driver.readRecords('clients'))).toHaveLength(2)
  })

  it('yields nothing for an unknown collection', async () => {
    expect(await drain(driver.readRecords('nope'))).toEqual([])
  })
})
