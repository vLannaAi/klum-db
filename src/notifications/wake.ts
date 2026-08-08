/**
 * @klum-db/lobby notifications — content-free push wake-up (#39).
 *
 * APNs / FCM / Web Push all need a SERVER to send, holding platform
 * credentials. This is a client-side library, so it ships no sender and no
 * credential: the app implements `WakeSender` on its own infrastructure and
 * passes it in. klum-db decides WHICH endpoints to wake and calls out.
 *
 * Push is an OPTIMIZATION, never a delivery mechanism. Records are written
 * before any wake is attempted, so a sender outage cannot cost a
 * notification — a client that misses a wake sees it on the next sync.
 *
 * @module
 */
import type { DeviceEndpoint, DeviceRegistry } from './devices.js'
import type { NotificationIntent, NotificationSink } from './types.js'

export interface WakeFailure {
  readonly endpointId: string
  readonly reason: string
  /** The endpoint will never work again (Web Push 410 Gone, APNs equivalent). */
  readonly permanent?: boolean
}

export interface WakeResult {
  readonly delivered: number
  readonly failed: readonly WakeFailure[]
}

/**
 * Implemented by the app, on the app's own server.
 *
 * `wake` takes NO payload parameter — not an empty one, not an optional
 * one. A push may not carry notification content: a body reading "Advisor
 * Jo changed Client X's risk rating" would leak to the push service and to
 * any lock screen exactly what the vault exists to protect. Making it
 * unrepresentable is how that rule is enforced rather than merely
 * documented. Do not add an argument here.
 */
export interface WakeSender {
  wake(endpoints: readonly DeviceEndpoint[]): Promise<WakeResult>
}

export interface WithWakeOptions {
  registry: DeviceRegistry
  sender: WakeSender
  onWakeError?: (err: unknown) => void
}

const warn = (err: unknown): void => {
  console.warn('[klum-db] notification wake failed:', err)
}

/**
 * Wrap a delivery sink so it wakes the recipients' devices afterwards.
 *
 * Delivery runs FIRST and its failures propagate — there is nothing worth
 * waking a client for if no record was written. The wake itself is
 * best-effort: its errors go to `onWakeError` and never propagate, so a
 * dead push service cannot fail a user's business write.
 */
export function withWake(sink: NotificationSink, opts: WithWakeOptions): NotificationSink {
  const onWakeError = opts.onWakeError ?? warn
  return async (intent: NotificationIntent): Promise<void> => {
    await sink(intent)
    try {
      const recipients = new Set(intent.recipients)
      const endpoints: DeviceEndpoint[] = (await opts.registry.listAll())
        .filter((d) => recipients.has(d.actor))
        .map((d) => ({ endpointId: d.endpointId, kind: d.kind, token: d.token }))
      if (endpoints.length === 0) return
      const result = await opts.sender.wake(endpoints)
      for (const f of result.failed) {
        if (f.permanent === true) await opts.registry.unregister(f.endpointId)
      }
    } catch (err) {
      onWakeError(err)
    }
  }
}
