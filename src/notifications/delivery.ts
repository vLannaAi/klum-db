/**
 * @klum-db/lobby notifications — the sink (#38).
 *
 * Turns one #37 intent into one record PER RECIPIENT. Fan-out on write is
 * what makes dismissal converge without a CRDT: each record has exactly one
 * owner, so a user's devices only ever contend on their own record.
 *
 * @module
 */
import { deriveNotificationId } from './record.js'
import type { NotificationRecord } from './record.js'
import type { NotificationIntent, NotificationSink } from './types.js'

/** The write side this sink needs — a collection, or anything shaped like one. */
export interface NotificationWriter {
  put(id: string, record: NotificationRecord): Promise<void>
}

export interface SinkOptions {
  /** When set, each record gets `expiresAt = createdAt + defaultTtlMs`. */
  defaultTtlMs?: number
  /** Injectable clock (a function) — tests pass a fixed one. */
  now?: () => number
}

/**
 * Build a sink that persists intents as per-recipient notification records.
 *
 * This sink writes into the SAME hub the #37 engine is attached to — it does
 * not recurse only because the hub's `WriteHookRegistry` suppresses nested
 * `onAfterWrite` firing for writes made from inside a hook. A rule matching
 * `collection: 'notifications'` would otherwise fan out into itself forever.
 */
export function createNotificationSink(
  writer: NotificationWriter,
  opts: SinkOptions = {},
): NotificationSink {
  const clock = opts.now ?? (() => Date.now())
  return async (intent: NotificationIntent): Promise<void> => {
    const createdAt = clock()
    // Each recipient's write is guarded so one failure does not abort the
    // rest of the fan-out. Record ids are deterministic (deriveNotificationId),
    // so re-delivering the whole intent after a partial failure is safe and
    // idempotent — recipients that already succeeded just get overwritten
    // with the same record.
    const failures: Array<{ recipient: string; err: unknown }> = []
    for (const recipient of intent.recipients) {
      const id = await deriveNotificationId(intent.ruleId, intent.ref, recipient)
      const record: NotificationRecord = {
        id,
        recipient,
        ruleId: intent.ruleId,
        actorId: intent.actorId,
        op: intent.op,
        ref: intent.ref,
        createdAt,
        dismissedAt: null,
        ...(intent.actorRole !== undefined ? { actorRole: intent.actorRole } : {}),
        ...(intent.severity !== undefined ? { severity: intent.severity } : {}),
        ...(opts.defaultTtlMs !== undefined ? { expiresAt: createdAt + opts.defaultTtlMs } : {}),
      }
      try {
        await writer.put(id, record)
      } catch (err) {
        failures.push({ recipient, err })
      }
    }
    if (failures.length > 0) {
      const { vaultId, collection, recordId, version } = intent.ref
      throw new Error(
        `notification delivery failed for ${failures.length}/${intent.recipients.length} recipient(s) `
        + `(rule "${intent.ruleId}", ref ${vaultId}/${collection}/${recordId}@${version}): `
        + failures.map((f) => `${f.recipient}: ${String(f.err instanceof Error ? f.err.message : f.err)}`).join('; '),
      )
    }
  }
}
