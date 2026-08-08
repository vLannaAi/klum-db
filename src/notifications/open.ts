/**
 * @klum-db/lobby notifications — ensure + wire (#38).
 *
 * Creates the per-fleet notifications vault on first call and records it in
 * a DEDICATED registry collection. It is deliberately NOT written to
 * `vault-registry`: a row there marks a shard, and the notifications vault
 * would be swept into `crossShardJoin` / `queryAcrossLive` /
 * `aggregateAcross` and — worse — into `rolloutSchema`, which would run a
 * client-schema cutover against it. Keeping it out of that registry makes
 * the mistake structurally impossible rather than something to remember.
 *
 * Throws on failure: this is explicit setup, not a write-path callback, and
 * failing quietly would leave notifications vanishing with no signal.
 *
 * @module
 */
import { STATE_VAULT_NAME } from '@noy-db/hub/cargo'
import type { Noydb } from '@noy-db/hub/cargo'
import { createNotificationSink } from './delivery.js'
import { NotificationInbox } from './inbox.js'
import {
  NOTIFICATIONS_COLLECTION,
  NOTIFICATIONS_REGISTRY_COLLECTION,
  notificationsVaultName,
} from './record.js'
import type { NotificationRecord, NotificationsRegistryRow } from './record.js'
import type { NotificationSink } from './types.js'

/** The minimum of a VaultGroup this needs — name + its hub handle. */
export interface NotificationsGroupRef {
  readonly name: string
  readonly db: Noydb
}

export interface OpenNotificationsOptions {
  /** When set, each written record expires this many ms after creation. */
  defaultTtlMs?: number
  /** Injectable clock — tests pass a fixed one. */
  now?: () => number
}

export interface NotificationsHandle {
  /** Pass to a #37 `NotificationRuleEngine` as its `sink`. */
  readonly sink: NotificationSink
  readonly inbox: NotificationInbox
  /**
   * The notifications vault's name. Exposed so callers can grant recipients
   * read access — `openNotifications` deliberately does NOT grant.
   */
  readonly vaultId: string
}

export async function openNotifications(
  group: NotificationsGroupRef,
  opts: OpenNotificationsOptions = {},
): Promise<NotificationsHandle> {
  const clock = opts.now ?? (() => Date.now())
  const vaultId = notificationsVaultName(group.name)

  const vault = await group.db.openVault(vaultId)
  const records = vault.collection<NotificationRecord>(NOTIFICATIONS_COLLECTION)

  const state = await group.db.openVault(STATE_VAULT_NAME)
  const registry = state.collection<NotificationsRegistryRow>(NOTIFICATIONS_REGISTRY_COLLECTION)
  if ((await registry.get(vaultId)) === null) {
    await registry.put(vaultId, { vaultId, group: group.name, createdAt: clock() })
  }

  return {
    sink: createNotificationSink(records, {
      now: clock,
      ...(opts.defaultTtlMs !== undefined ? { defaultTtlMs: opts.defaultTtlMs } : {}),
    }),
    inbox: new NotificationInbox(records),
    vaultId,
  }
}
