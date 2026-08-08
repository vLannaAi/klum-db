# Notifications push wake-up (#39) — design

> Slice 3 of milestone 4, per the accepted spec
> [`docs/notifications-cross-actor.md`](./notifications-cross-actor.md) (#36).
> Builds on [`docs/notifications-in-app-delivery.md`](./notifications-in-app-delivery.md) (#38).
> Status: **approved 2026-08-08.**

## Scope — and what deliberately is NOT here

APNs, FCM and Web Push all require a **server** to send, holding platform
credentials. `@klum-db/lobby` is a client-side library running inside a
user's session. Shipping an APNs key into a client bundle would be a
straightforward secret leak, so this slice does not do it.

**In scope (klum-db):**

- Device / endpoint registration as fleet state.
- Resolving which endpoints to wake for a given notification.
- A narrow `WakeSender` contract the app implements on its own server.
- Pruning endpoints a sender reports as permanently dead.
- The documented policy: no content in a push, ever.

**Out of scope (belongs to whoever owns server infrastructure):**

- APNs / FCM / VAPID senders themselves. No platform SDK dependency is
  added here, and no credential of any kind enters this package.

The family has no push infrastructure today — noy-db's `by-*` family is
`by-peer` (WebRTC) and `by-tabs` (BroadcastChannel), both credential-free
peer transports. #39 does not change that; it defines the seam a future
sender plugs into.

## The contract

```ts
export interface DeviceEndpoint {
  readonly endpointId: string
  readonly kind: 'web-push' | 'apns' | 'fcm'
  readonly token: string
}

export interface WakeSender {
  wake(endpoints: readonly DeviceEndpoint[]): Promise<WakeResult>
}

export interface WakeResult {
  readonly delivered: number
  readonly failed: readonly WakeFailure[]
}

export interface WakeFailure {
  readonly endpointId: string
  readonly reason: string
  /** The endpoint will never work again (Web Push 410 Gone, APNs equivalent). */
  readonly permanent?: boolean
}
```

### `wake` takes no payload parameter

Not an empty one. Not an optional one. There is **no argument through which
notification content could travel.**

The governing issue states that a push payload may not carry notification
content and that this is "not a tuning knob" — rich push is incompatible
with the product's core claim, because a payload reading *"Advisor Jo
changed Client X's risk rating"* leaks to the push service and to anyone
reading a lock screen exactly what the vault exists to protect.

Making that unrepresentable in the type is how the rule is enforced, rather
than documented and hoped for. It is the same move as `NotificationIntent`
and `NotificationRecord` having no field-value slot.

The client wakes → syncs → decrypts locally → renders from its own data.

## Device registration

Registrations live in a `devices` collection **inside the existing
notifications vault**, beside the notifications they wake.

```ts
export interface DeviceRegistration {
  readonly endpointId: string
  readonly actor: string
  readonly kind: 'web-push' | 'apns' | 'fcm'
  readonly token: string
  readonly registeredAt: number
  readonly label?: string
}
```

`endpointId` is derived — `sha256Hex` over `kind` + `token`, length-prefixed
per component, matching the notification-id derivation in `record.ts`. So
re-registering the same device is idempotent rather than accumulating
duplicates.

**Why this vault.** The writing session must READ a recipient's endpoints in
order to wake them, so every actor who may emit a notification must be able
to read them. They already hold a grant on the notifications vault, so this
adds no new grant step and widens no trust boundary — anyone who can read
the endpoints can already read every notification.

A separate devices vault was rejected: every emitting actor would need its
grant too, arriving at nearly the same reader set for the cost of another
vault and another grant step. Per-actor storage was rejected because it
makes the recipient's endpoints unreadable by the sender, which breaks
automatic wake entirely.

**Known metadata exposure:** a grant holder can enumerate which actors have
registered devices, and of what kind. Accepted within the fleet boundary,
on the same reasoning as the registry and the notification records.

## Wake flow

`openNotifications(group, { wakeSender })` wires it. After the sink writes
its records:

1. Resolve the intent's recipients to registered endpoints (one query).
2. Call `wakeSender.wake(endpoints)` **once per intent**, not once per
   recipient — fewer round-trips and a natural batching point for the sender.
3. Delete any registration whose failure reports `permanent: true`.

With no `wakeSender` configured, delivery behaves exactly as in #38 and no
wake is attempted.

**Failures are best-effort.** A wake failure is reported through the same
`onError` path as a sink failure and never propagates — #37's `attach()`
already contains everything, so a dead push service cannot fail a user's
business write. Records are written **before** any wake is attempted, so a
sender outage cannot cost a notification.

## Fallback: push is an optimization, never a delivery mechanism

The issue asks what happens when a client cannot sync on wake — offline,
revoked, key rotated.

Nothing is lost. The notification record is already durable in the vault
from #38; the wake only shortens the latency to noticing it. A client that
misses a wake sees the notification on its next sync or inbox read.

This is the property that makes a content-free push tolerable: **push can
fail completely and delivery still works.** Any future design that makes
correctness depend on a wake arriving would be a regression, not an
enhancement.

## Traffic analysis — the residual leak, accepted

An empty payload does not hide **timing and frequency**. A push service can
observe that some actor was woken, and when — enough to infer activity
patterns without ever seeing content.

**Decision: accepted and documented, not mitigated in klum-db.**

Mitigation means padding, batching, or jitter, and all three are properties
of *when sends happen* — which klum-db does not control. The app's server
owns the sender and is the only place those can be applied. Adding a jitter
knob here would be a control that does not actually control anything.

Recorded as a known limitation, with the note that a deployment needing
resistance to traffic analysis should implement batching or jitter inside
its `WakeSender`.

## Relationship to the `at-*` family

A push sender is host infrastructure the operator controls — the one
sanctioned non-zero-knowledge surface family. This design introduces **no**
server-side decryption: the sender receives endpoints and nothing else, and
cannot read a notification even in principle, because it is never given one.

If server-side decryption is ever proposed here, it must be an explicit,
documented `at-*`-style decision — not an accident of a payload parameter
appearing on `wake`.

## Module layout

Extends `src/notifications/`.

| File | Purpose | Depends on |
|---|---|---|
| `devices.ts` | `DeviceRegistration`, endpoint id derivation, register / unregister / list | `record.ts`, `/cargo` |
| `wake.ts` | `WakeSender` / `WakeResult` / `WakeFailure`, endpoint resolution, the wake step incl. pruning | `devices.ts` |
| `open.ts` (modify) | accept `wakeSender`, wire the wake step after delivery, expose `devices` on the handle | both |

Boundary unchanged: `@noy-db/hub/cargo` only.

## Public surface

The handle gains a `devices` facade:

```ts
const { sink, inbox, devices, vaultId } = await lobby.openNotifications(group, { wakeSender })

await devices.register({ actor: 'u_ben', kind: 'web-push', token: '…' })
await devices.list('u_ben')
await devices.unregister(endpointId)
```

Reaching the package root: `DeviceRegistration`, `DeviceEndpoint`,
`WakeSender`, `WakeResult`, `WakeFailure`. Internal: endpoint-id derivation,
the resolution helper, the collection name. This follows #37/#38's rule that
root exports are permanent npm commitments and stay deliberately narrow.

## Testing

Pure (no vault):

- endpoint id derivation is deterministic, varies with `kind` and `token`,
  and length-prefixing prevents a delimiter in a token from colliding with
  another tuple (mutation-verified against a naive join, per the #38 finding)
- the wake step calls `wake` ONCE per intent with all recipients' endpoints
- a recipient with no registered device is simply absent, not an error
- with no `wakeSender`, no wake is attempted
- a `permanent: true` failure prunes that registration; a non-permanent one
  does not
- a throwing `wakeSender` does not prevent records from being written

Integration (real in-memory hub, `memoryStore` from
`__tests__/helpers/two-shard-group.ts`):

- register → deliver an intent → the fake sender receives exactly the
  registered endpoints, and the notification is readable in the inbox
- re-registering the same device is idempotent (one row)
- a permanently-failed endpoint is gone from `devices.list` afterwards
- **records are written even when the sender throws** — the property the
  fallback story rests on

## Follow-ups (not this slice)

- An actual `WakeSender` implementation, wherever server infrastructure
  lands. This slice defines the seam it plugs into.
- Batching / jitter inside that sender, if a deployment needs resistance to
  traffic analysis.
