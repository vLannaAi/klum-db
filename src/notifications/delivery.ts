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
  /** Injectable clock — tests pass a fixed one. */
  now?: () => number
}

/** Build a sink that persists intents as per-recipient notification records. */
export function createNotificationSink(
  writer: NotificationWriter,
  opts: SinkOptions = {},
): NotificationSink {
  const clock = opts.now ?? (() => Date.now())
  return async (intent: NotificationIntent): Promise<void> => {
    const createdAt = clock()
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
      await writer.put(id, record)
    }
  }
}
