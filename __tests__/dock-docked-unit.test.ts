import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'
import { createLobby } from '../src/index.js'
import { InMemoryUnitDriver } from '../src/dock/unit-driver.js'
import { DockedUnit } from '../src/dock/docked-unit.js'

async function lobby() {
  const db = await createNoydb({ store: memory(), user: 'firm', secret: 'firm-secret-123' })
  return createLobby(db)
}

const driver = () => new InMemoryUnitDriver('legacy-1', { clients: [{ id: '1', name: 'Acme' }] })

describe('Lobby.dock → DockedUnit (lower tier)', () => {
  it('docks a foreign unit and carries it read-only', async () => {
    const lob = await lobby()
    const docked = lob.dock(driver())
    expect(docked).toBeInstanceOf(DockedUnit)
    expect(docked.unitId).toBe('legacy-1')
    expect([...(await docked.listCollections())]).toEqual(['clients'])
  })

  it('exposes ONLY read-only carry — no sovereign surface (tier boundary)', async () => {
    const lob = await lobby()
    const docked = lob.dock(driver()) as unknown as Record<string, unknown>
    // The sovereign tier does not exist on a docked unit.
    for (const sovereign of ['custody', 'liberate', 'forget', 'resolveFieldAuthority', 'grantCustodian']) {
      expect(docked[sovereign]).toBeUndefined()
    }
  })
})
