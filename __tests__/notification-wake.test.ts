/**
 * Push wake-up (#39) — the wake step. Pure; no vault.
 */
import { describe, it, expect, vi } from 'vitest'
import { withWake } from '../src/notifications/wake.js'
import type { WakeResult, WakeSender } from '../src/notifications/wake.js'
import { DeviceRegistry } from '../src/notifications/devices.js'
import type { DeviceRegistration } from '../src/notifications/devices.js'
import type { NotificationIntent } from '../src/notifications/types.js'

function fakeStore(seed: DeviceRegistration[] = []) {
  const rows = new Map(seed.map((r) => [r.endpointId, r]))
  return {
    rows,
    async list() { return [...rows.keys()] },
    query() { return { toArray: () => [...rows.values()] } },
    async get(id: string) { return rows.get(id) ?? null },
    async put(id: string, r: DeviceRegistration) { rows.set(id, r) },
    async delete(id: string) { rows.delete(id) },
  }
}

const INTENT: NotificationIntent = {
  ruleId: 'r', actorId: 'u_ada', op: 'update',
  ref: { vaultId: 'v', collection: 'c', recordId: 'x', version: 1 },
  recipients: ['u_ben', 'u_cy'], ts: 1_000,
}

const OK: WakeResult = { delivered: 1, failed: [] }

async function seeded() {
  const store = fakeStore()
  const registry = new DeviceRegistry(store, () => 1)
  await registry.register({ actor: 'u_ben', kind: 'web-push', token: 'ben-tok' })
  await registry.register({ actor: 'u_cy', kind: 'apns', token: 'cy-tok' })
  await registry.register({ actor: 'u_zoe', kind: 'fcm', token: 'zoe-tok' })
  return { store, registry }
}

describe('withWake', () => {
  it('delivers first, then wakes — records exist before any push', async () => {
    const order: string[] = []
    const { registry } = await seeded()
    const sender = { wake: async () => { order.push('wake'); return OK } }
    const sink = withWake(
      async () => { await Promise.resolve(); order.push('deliver') },
      { registry, sender },
    )
    await sink(INTENT)
    expect(order).toEqual(['deliver', 'wake'])
  })

  it('wakes ONCE per intent with all recipients’ endpoints', async () => {
    const { registry } = await seeded()
    const wake = vi.fn(async () => OK)
    await withWake(async () => {}, { registry, sender: { wake } })(INTENT)
    expect(wake).toHaveBeenCalledTimes(1)
    const tokens = wake.mock.calls[0]![0].map((e) => e.token).sort()
    expect(tokens).toEqual(['ben-tok', 'cy-tok'])
  })

  it('does not wake devices of actors who are not recipients', async () => {
    const { registry } = await seeded()
    const wake = vi.fn(async () => OK)
    await withWake(async () => {}, { registry, sender: { wake } })(INTENT)
    expect(wake.mock.calls[0]![0].map((e) => e.token)).not.toContain('zoe-tok')
  })

  it('passes endpoints only — no actor, no content', async () => {
    const { registry } = await seeded()
    const wake = vi.fn(async () => OK)
    await withWake(async () => {}, { registry, sender: { wake } })(INTENT)
    const endpoints = wake.mock.calls[0]![0]
    expect(endpoints).toHaveLength(2)
    for (const e of endpoints) expect(Object.keys(e).sort()).toEqual(['endpointId', 'kind', 'token'])
    const json = JSON.stringify(wake.mock.calls[0])
    expect(json).not.toContain('u_ben')
    expect(json).not.toContain('riskRating')
  })

  it('skips the wake entirely when no recipient has a device', async () => {
    const store = fakeStore()
    const registry = new DeviceRegistry(store, () => 1)
    // A device exists, but for a NON-recipient — an implementation that
    // ignored the recipient filter would still call wake here.
    await registry.register({ actor: 'u_zoe', kind: 'fcm', token: 'zoe-tok' })
    const wake = vi.fn(async () => OK)
    await withWake(async () => {}, { registry, sender: { wake } })(INTENT)
    expect(wake).not.toHaveBeenCalled()
  })

  it('prunes an endpoint whose failure is permanent', async () => {
    const { store, registry } = await seeded()
    const before = (await registry.list('u_ben'))[0]!
    const sender = {
      wake: async (): Promise<WakeResult> => ({
        delivered: 1,
        failed: [{ endpointId: before.endpointId, reason: 'gone', permanent: true }],
      }),
    }
    await withWake(async () => {}, { registry, sender })(INTENT)
    expect(await registry.list('u_ben')).toEqual([])
    expect(store.rows.size).toBe(2)
  })

  it('keeps an endpoint whose failure is transient', async () => {
    const { registry } = await seeded()
    const before = (await registry.list('u_ben'))[0]!
    const sender = {
      wake: async (): Promise<WakeResult> => ({
        delivered: 1,
        failed: [{ endpointId: before.endpointId, reason: 'timeout' }],
      }),
    }
    await withWake(async () => {}, { registry, sender })(INTENT)
    expect(await registry.list('u_ben')).toHaveLength(1)
  })

  it('is best-effort: a throwing sender does not propagate, and delivery still happened', async () => {
    const { registry } = await seeded()
    const delivered: string[] = []
    const onWakeError = vi.fn()
    const sink = withWake(
      async () => { delivered.push('yes') },
      { registry, sender: { wake: async () => { throw new Error('push down') } }, onWakeError },
    )
    await expect(sink(INTENT)).resolves.toBeUndefined()
    expect(delivered).toEqual(['yes'])
    expect(onWakeError).toHaveBeenCalledTimes(1)
  })

  it('propagates a delivery failure and does not wake', async () => {
    const { registry } = await seeded()
    const wake = vi.fn(async () => OK)
    const sink = withWake(
      async () => { throw new Error('write failed') },
      { registry, sender: { wake } },
    )
    await expect(sink(INTENT)).rejects.toThrow('write failed')
    expect(wake).not.toHaveBeenCalled()
  })

  it('is best-effort even when pruning a permanently-failed endpoint rejects', async () => {
    // Covers the third throw site: registry.unregister() inside the prune
    // loop. If a refactor narrowed the try block to wrap only sender.wake,
    // this rejection would escape uncaught and this test would fail.
    const { store, registry } = await seeded()
    const before = (await registry.list('u_ben'))[0]!
    vi.spyOn(store, 'delete').mockRejectedValue(new Error('delete down'))
    const sender = {
      wake: async (): Promise<WakeResult> => ({
        delivered: 1,
        failed: [{ endpointId: before.endpointId, reason: 'gone', permanent: true }],
      }),
    }
    const onWakeError = vi.fn()
    const sink = withWake(async () => {}, { registry, sender, onWakeError })
    await expect(sink(INTENT)).resolves.toBeUndefined()
    expect(onWakeError).toHaveBeenCalledTimes(1)
  })

  it('is best-effort even when reading the device registry itself rejects', async () => {
    // Covers the first throw site: registry.listAll(). If a refactor
    // narrowed the try block to start after this call, this rejection
    // would escape uncaught and this test would fail.
    const store = fakeStore()
    const registry = new DeviceRegistry(store, () => 1)
    vi.spyOn(store, 'list').mockRejectedValue(new Error('list down'))
    const wake = vi.fn(async () => OK)
    const onWakeError = vi.fn()
    const sink = withWake(async () => {}, { registry, sender: { wake }, onWakeError })
    await expect(sink(INTENT)).resolves.toBeUndefined()
    expect(onWakeError).toHaveBeenCalledTimes(1)
    expect(wake).not.toHaveBeenCalled()
  })
})
