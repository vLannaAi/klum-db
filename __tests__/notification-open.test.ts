/**
 * Notifications in-app delivery (#38) — provisioning + end-to-end,
 * against a real in-memory hub.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { STATE_VAULT_NAME } from '@noy-db/hub/cargo'
import { memoryStore } from './helpers/two-shard-group.js'
import { createLobby } from '../src/index.js'
import {
  NOTIFICATIONS_REGISTRY_COLLECTION,
  notificationsVaultName,
} from '../src/notifications/record.js'
import type { NotificationsRegistryRow } from '../src/notifications/record.js'
import type { NotificationIntent } from '../src/notifications/types.js'

const INTENT: NotificationIntent = {
  ruleId: 'risk-escalation',
  actorId: 'u_ada',
  op: 'update',
  ref: { vaultId: 'shard_x', collection: 'clients', recordId: 'c1', version: 5 },
  recipients: ['u_ben'],
  ts: 1_000,
}

async function harness() {
  const db = await createNoydb({ store: memoryStore(), user: 'u_ada', secret: 'op-pass' })
  const lobby = createLobby(db)
  return { db, lobby, group: { name: 'firm-clients', db } }
}

describe('openNotifications (#38)', () => {
  it('creates the per-fleet vault and returns a usable handle', async () => {
    const h = await harness()
    const handle = await h.lobby.openNotifications(h.group, { now: () => 1_000 })
    expect(handle.vaultId).toBe(notificationsVaultName('firm-clients'))
    expect(typeof handle.sink).toBe('function')
    expect(handle.inbox).toBeDefined()
  })

  it('registers the vault in notifications-registry, NOT vault-registry', async () => {
    const h = await harness()
    await h.lobby.openNotifications(h.group)

    const state = await h.db.openVault(STATE_VAULT_NAME)
    const notifReg = state.collection<NotificationsRegistryRow>(NOTIFICATIONS_REGISTRY_COLLECTION)
    await notifReg.list()
    const rows = notifReg.query().toArray()
    expect(rows.map((r) => r.vaultId)).toEqual([notificationsVaultName('firm-clients')])

    // The shard registry must NOT have learned about it — a row there would
    // make the notifications vault a shard, sweeping it into fan-out queries
    // and into rolloutSchema.
    const shardReg = state.collection<{ vaultId: string }>('vault-registry')
    await shardReg.list()
    expect(shardReg.query().toArray().map((r) => r.vaultId)).not.toContain(
      notificationsVaultName('firm-clients'),
    )
  })

  it('is idempotent — a second call reuses the vault and adds no second row', async () => {
    const h = await harness()
    const a = await h.lobby.openNotifications(h.group)
    const b = await h.lobby.openNotifications(h.group)
    expect(b.vaultId).toBe(a.vaultId)

    const state = await h.db.openVault(STATE_VAULT_NAME)
    const reg = state.collection<NotificationsRegistryRow>(NOTIFICATIONS_REGISTRY_COLLECTION)
    await reg.list()
    expect(reg.query().toArray()).toHaveLength(1)
  })

  it('delivers an intent through the sink and reads it back from the inbox', async () => {
    const h = await harness()
    const { sink, inbox } = await h.lobby.openNotifications(h.group, { now: () => 1_000 })

    await sink(INTENT)

    const got = await inbox.list({ recipient: 'u_ben', now: 2_000 })
    expect(got).toHaveLength(1)
    expect(got[0]!.ruleId).toBe('risk-escalation')
    expect(got[0]!.ref.recordId).toBe('c1')
    expect(await inbox.unreadCount('u_ben', { now: 2_000 })).toBe(1)
  })

  it('dismissal persists and empties the inbox', async () => {
    const h = await harness()
    const { sink, inbox } = await h.lobby.openNotifications(h.group, { now: () => 1_000 })
    await sink(INTENT)
    const [n] = await inbox.list({ recipient: 'u_ben', now: 2_000 })

    await inbox.dismiss(n!.id, { at: 3_000 })

    expect(await inbox.list({ recipient: 'u_ben', now: 4_000 })).toEqual([])
    const kept = await inbox.list({ recipient: 'u_ben', now: 4_000, includeDismissed: true })
    expect(kept).toHaveLength(1)
    expect(kept[0]!.dismissedAt).toBe(3_000)
  })

  it('re-delivering the same intent does not duplicate the notification', async () => {
    const h = await harness()
    const { sink, inbox } = await h.lobby.openNotifications(h.group, { now: () => 1_000 })
    await sink(INTENT)
    await sink(INTENT)
    expect(await inbox.list({ recipient: 'u_ben', now: 2_000 })).toHaveLength(1)
  })

  it('expires a record once defaultTtlMs has elapsed', async () => {
    const h = await harness()
    const { sink, inbox } = await h.lobby.openNotifications(h.group, {
      now: () => 1_000, defaultTtlMs: 500,
    })
    await sink(INTENT)
    expect(await inbox.list({ recipient: 'u_ben', now: 1_200 })).toHaveLength(1)
    expect(await inbox.list({ recipient: 'u_ben', now: 1_600 })).toEqual([])
  })
})
