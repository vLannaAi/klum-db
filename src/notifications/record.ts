/**
 * @klum-db/lobby notifications — the delivered record (#38).
 *
 * A notification is a record owned by exactly ONE recipient: the sink fans
 * an intent out to N records. That is what makes dismissal converge under
 * ordinary last-write-wins, with no CRDT.
 *
 * Like the intent it comes from, the record carries REFERENCES ONLY —
 * never field values, diffs, or snapshots (spec § 4). Do not add a slot
 * for them; rendering dereferences `ref` client-side.
 *
 * @module
 */
import { sha256Hex } from '@noy-db/hub/cargo'
import type { NotificationRef, Severity, WriteOp } from './types.js'

/** Collection holding the delivered notifications, inside the notifications vault. */
export const NOTIFICATIONS_COLLECTION = 'notifications'

/**
 * Collection in the StateManagement vault recording which notifications
 * vaults exist. Deliberately NOT `vault-registry` — a row there is a shard,
 * and would be swept into fan-out queries and schema rollouts.
 */
export const NOTIFICATIONS_REGISTRY_COLLECTION = 'notifications-registry'

/** One delivered notification, owned by a single recipient. */
export interface NotificationRecord {
  readonly id: string
  readonly recipient: string
  readonly ruleId: string
  readonly actorId: string
  readonly actorRole?: string
  readonly op: WriteOp
  readonly ref: NotificationRef
  readonly severity?: Severity
  readonly createdAt: number
  readonly expiresAt?: number
  readonly dismissedAt?: number | null
}

/** Registry row for a per-fleet notifications vault. */
export interface NotificationsRegistryRow {
  readonly vaultId: string
  readonly group: string
  readonly createdAt: number
}

/** The per-fleet notifications vault's name. */
export function notificationsVaultName(group: string): string {
  return `notifications--${group}`
}

/**
 * Deterministic record id, so re-delivering the same intent overwrites
 * rather than duplicating.
 *
 * Keyed on the FULL ref plus recipient — never `ruleId` alone. Two rules
 * matching the same write are two reasons to be told, and produce two
 * notifications. Components are length-prefixed so a delimiter appearing
 * inside a value cannot forge a different tuple's id.
 */
export async function deriveNotificationId(
  ruleId: string,
  ref: NotificationRef,
  recipient: string,
): Promise<string> {
  const parts = [ruleId, ref.vaultId, ref.collection, ref.recordId, String(ref.version), recipient]
  const joined = parts.map((p) => `${p.length}:${p}`).join('|')
  return sha256Hex(new TextEncoder().encode(joined))
}
