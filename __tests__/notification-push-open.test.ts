/**
 * Push wake-up (#39) — end to end against a real in-memory hub.
 */
import { describe, it, expect, vi } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { memoryStore } from './helpers/two-shard-group.js'
import { createLobby } from '../src/index.js'
import type { WakeResult, WakeSender } from '../src/notifications/wake.js'
import type { NotificationIntent } from '../src/notifications/types.js'

const INTENT: NotificationIntent = {
  ruleId: 'risk-escalation', actorId: 'u_ada', op: 'update',
  ref: { vaultId: 'shard_x', collection: 'clients', recordId: 'c1', version: 5 },
  recipients: ['u_ben'], ts: 1_000,
}

const OK: WakeResult = { delivered: 1, failed: [] }

async function harness(wakeSender?: WakeSender, onWakeError?: (err: unknown) => void) {
  const db = await createNoydb({ store: memoryStore(), user: 'u_ada', secret: 'op-pass' })
  const lobby = createLobby(db)
  const handle = await lobby.openNotifications(
    { name: 'firm-clients', db },
    {
      now: () => 1_000,
      ...(wakeSender !== undefined ? { wakeSender } : {}),
      ...(onWakeError !== undefined ? { onWakeError } : {}),
    },
  )
  return { db, handle }
}

describe('openNotifications + push wake (#39)', () => {
  it('exposes a devices facade that persists registrations', async () => {
    const { handle } = await harness()
    await handle.devices.register({ actor: 'u_ben', kind: 'web-push', token: 'tok' })
    const mine = await handle.devices.list('u_ben')
    expect(mine).toHaveLength(1)
    expect(mine[0]!.kind).toBe('web-push')
  })

  it('registration is idempotent across handles on the same vault', async () => {
    const { db, handle } = await harness()
    await handle.devices.register({ actor: 'u_ben', kind: 'web-push', token: 'tok' })
    const lobby2 = createLobby(db)
    const again = await lobby2.openNotifications({ name: 'firm-clients', db })
    await again.devices.register({ actor: 'u_ben', kind: 'web-push', token: 'tok' })
    expect(await again.devices.list('u_ben')).toHaveLength(1)
  })

  it('wakes the recipient’s registered endpoints after delivery', async () => {
    const wake = vi.fn(async () => OK)
    const { handle } = await harness({ wake })
    await handle.devices.register({ actor: 'u_ben', kind: 'web-push', token: 'ben-tok' })

    await handle.sink(INTENT)

    expect(wake).toHaveBeenCalledTimes(1)
    expect((wake.mock.calls[0]![0] as { token: string }[]).map((e) => e.token)).toEqual(['ben-tok'])
    // Delivery still happened.
    expect(await handle.inbox.list({ recipient: 'u_ben', now: 2_000 })).toHaveLength(1)
  })

  it('with no wakeSender configured, delivery works and nothing is woken', async () => {
    // A registered recipient device is in place so a would-be wake attempt
    // has something to act on. If `openNotifications` always wrapped the
    // sink with `withWake` regardless of `opts.wakeSender`, the wake path
    // would try to call `.wake` on the missing sender, throw, and land in
    // `withWake`'s catch — which reports via `console.warn` by default.
    // Asserting `warn` was never called catches that bug even though
    // delivery still succeeds either way (wake failures never propagate).
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { handle } = await harness()
    await handle.devices.register({ actor: 'u_ben', kind: 'web-push', token: 'tok' })
    await handle.sink(INTENT)
    expect(await handle.inbox.list({ recipient: 'u_ben', now: 2_000 })).toHaveLength(1)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('a throwing sender does not cost the notification', async () => {
    const { handle } = await harness({ wake: async () => { throw new Error('push down') } })
    await handle.devices.register({ actor: 'u_ben', kind: 'web-push', token: 'tok' })

    await expect(handle.sink(INTENT)).resolves.toBeUndefined()

    expect(await handle.inbox.list({ recipient: 'u_ben', now: 2_000 })).toHaveLength(1)
  })

  it('reports a wake failure through onWakeError without costing delivery', async () => {
    const onWakeError = vi.fn()
    const { handle } = await harness(
      { wake: async () => { throw new Error('push down') } },
      onWakeError,
    )
    await handle.devices.register({ actor: 'u_ben', kind: 'web-push', token: 'tok' })

    await handle.sink(INTENT)

    expect(onWakeError).toHaveBeenCalledTimes(1)
    expect(await handle.inbox.list({ recipient: 'u_ben', now: 2_000 })).toHaveLength(1)
  })

  it('prunes a permanently-dead endpoint from the persisted registry', async () => {
    let deadId = ''
    const { handle } = await harness({
      wake: async (endpoints) => ({
        delivered: 0,
        failed: [{ endpointId: (endpoints as { endpointId: string }[])[0]!.endpointId, reason: 'gone', permanent: true }],
      }),
    })
    const row = await handle.devices.register({ actor: 'u_ben', kind: 'web-push', token: 'tok' })
    deadId = row.endpointId

    await handle.sink(INTENT)

    expect(await handle.devices.list('u_ben')).toEqual([])
    expect(deadId).not.toBe('')
  })
})
