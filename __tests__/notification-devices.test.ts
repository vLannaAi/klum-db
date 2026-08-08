/**
 * Push wake-up (#39) — device registration. Pure; no vault.
 */
import { describe, it, expect } from 'vitest'
import { DeviceRegistry, deriveEndpointId } from '../src/notifications/devices.js'
import type { DeviceRegistration } from '../src/notifications/devices.js'

function fakeStore(seed: DeviceRegistration[] = []) {
  const rows = new Map(seed.map((r) => [r.endpointId, r]))
  return {
    rows,
    hydrated: 0,
    async list() { this.hydrated++; return [...rows.keys()] },
    query() { return { toArray: () => [...rows.values()] } },
    async put(id: string, r: DeviceRegistration) { rows.set(id, r) },
    async delete(id: string) { rows.delete(id) },
  }
}

describe('deriveEndpointId', () => {
  it('is deterministic', async () => {
    expect(await deriveEndpointId('web-push', 'tok')).toBe(await deriveEndpointId('web-push', 'tok'))
  })

  it('varies with kind and with token', async () => {
    const a = await deriveEndpointId('web-push', 'tok')
    expect(await deriveEndpointId('apns', 'tok')).not.toBe(a)
    expect(await deriveEndpointId('web-push', 'tok2')).not.toBe(a)
  })

  it('does not collide when the delimiter appears inside a component', async () => {
    // Adjacent components: a naive join would make these identical.
    const a = await deriveEndpointId('web-push' as never, 'x|y')
    const b = await deriveEndpointId('web-push|x' as never, 'y')
    expect(a).not.toBe(b)
  })
})

describe('DeviceRegistry', () => {
  it('registers a device under its derived id', async () => {
    const store = fakeStore()
    const reg = new DeviceRegistry(store, () => 1_000)
    const row = await reg.register({ actor: 'u_ben', kind: 'web-push', token: 'tok' })
    expect(row.endpointId).toBe(await deriveEndpointId('web-push', 'tok'))
    expect(row.actor).toBe('u_ben')
    expect(row.registeredAt).toBe(1_000)
    expect(store.rows.size).toBe(1)
  })

  it('is idempotent — re-registering the same device keeps one row', async () => {
    const store = fakeStore()
    const reg = new DeviceRegistry(store, () => 1_000)
    await reg.register({ actor: 'u_ben', kind: 'web-push', token: 'tok' })
    await reg.register({ actor: 'u_ben', kind: 'web-push', token: 'tok' })
    expect(store.rows.size).toBe(1)
  })

  it('carries an optional label and omits it when absent', async () => {
    const store = fakeStore()
    const reg = new DeviceRegistry(store, () => 1)
    const withLabel = await reg.register({ actor: 'u_ben', kind: 'apns', token: 't', label: 'phone' })
    const without = await reg.register({ actor: 'u_cy', kind: 'fcm', token: 't2' })
    expect(withLabel.label).toBe('phone')
    expect(without.label).toBeUndefined()
  })

  it('lists only the given actor’s devices, hydrating first', async () => {
    const store = fakeStore()
    const reg = new DeviceRegistry(store, () => 1)
    await reg.register({ actor: 'u_ben', kind: 'web-push', token: 'a' })
    await reg.register({ actor: 'u_cy', kind: 'web-push', token: 'b' })
    const mine = await reg.list('u_ben')
    expect(mine.map((d) => d.actor)).toEqual(['u_ben'])
    expect(store.hydrated).toBeGreaterThan(0)
  })

  it('listAll returns every registration', async () => {
    const store = fakeStore()
    const reg = new DeviceRegistry(store, () => 1)
    await reg.register({ actor: 'u_ben', kind: 'web-push', token: 'a' })
    await reg.register({ actor: 'u_cy', kind: 'web-push', token: 'b' })
    expect(await reg.listAll()).toHaveLength(2)
  })

  it('unregisters by endpoint id', async () => {
    const store = fakeStore()
    const reg = new DeviceRegistry(store, () => 1)
    const row = await reg.register({ actor: 'u_ben', kind: 'web-push', token: 'a' })
    await reg.unregister(row.endpointId)
    expect(store.rows.size).toBe(0)
    expect(await reg.list('u_ben')).toEqual([])
  })

  it('unregistering an unknown id is a no-op, not an error', async () => {
    const reg = new DeviceRegistry(fakeStore(), () => 1)
    await expect(reg.unregister('nope')).resolves.toBeUndefined()
  })
})
