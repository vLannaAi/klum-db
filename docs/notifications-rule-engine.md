# Notifications rule engine (#37) — design

> Implements slice 1 of milestone 4, per the accepted spec
> [`docs/notifications-cross-actor.md`](./notifications-cross-actor.md) (#36).
> Status: **approved 2026-08-08.**

## Scope

`#37` ships the **rule engine only**: rule representation, evaluation against
actor-side write events, and emission of a **notification intent** to a
caller-supplied sink.

Explicitly **out of scope** (they belong to #38 / #39):

- Opening, provisioning or writing to the notifications vault.
- Persisting or loading rules (rules arrive as data from the caller).
- Grants, revocation, inbox queries, dismissal convergence, push transport.

The engine never opens a vault and never writes a record. #38 supplies a sink
that persists intents into the per-fleet notifications vault.

## Placement: actor-side, post-write

Per spec § 0, rules evaluate **in the session that performs the write**. The
engine registers `onAfterWrite` on the caller's own `Noydb` instance, so the
event carries the decrypted `before` and `after` with zero extra reads.

`onBeforeWrite` is deliberately **not** used. A before-hook throw aborts the
write; a notification rule must never be able to block a business write, and
notifying about a write that was subsequently aborted would be incorrect.

The portal-actor gap (a client writing from the LIFF/PWA shell does not run the
fleet's rule engine) remains deferred exactly as spec § 0 records it.

## Seam binding

Everything binds the published `@noy-db/hub/cargo` subpath. No hub internals.

```ts
import type { WriteHook, Unsubscribe, Noydb } from '@noy-db/hub/cargo'
import { readPath } from '@noy-db/hub/cargo'

type WriteEvent = Parameters<WriteHook>[0]
```

**Known seam gap.** `/cargo` exports `WriteHook` but **not** `WriteEvent` by
name, so the event shape is reachable only structurally via
`Parameters<WriteHook>[0]`. This is correct and boundary-safe, but every
consumer writing a hook must rediscover it. File an upstream noy-db issue
asking for `WriteEvent` to be exported alongside `WriteHook`; drop the local
alias once it lands.

Dotted field paths are resolved with hub's own `readPath` (exported from
`/cargo`'s floor), so path semantics match the query DSL rather than
introducing a second, subtly different path reader in this repo.

## Module layout

New directory `src/notifications/`, re-exported from `src/index.ts`.

| File | Purpose | Depends on |
|---|---|---|
| `types.ts` | Rule / roster / intent / sink types | — |
| `match.ts` | Pure matching + recipient resolution | `types.ts` |
| `rule-engine.ts` | `NotificationRuleEngine` — holds rules + sink, attaches to a hub | both, `/cargo` |

## Types

```ts
export type WriteOp = 'create' | 'update' | 'delete'

export interface FieldCondition {
  /** Dotted path, read with hub's `readPath`. */
  field: string
  changed?: boolean
  from?: unknown
  to?: unknown
  equals?: unknown
}

export type RecipientSpec =
  | { kind: 'actors'; ids: readonly string[] }
  | { kind: 'role'; role: string }
  | { kind: 'vaultOwner' }
  | { kind: 'assignees' }

export interface NotificationRule {
  id: string
  collection: string
  ops?: readonly WriteOp[]
  vaults?: readonly string[]
  actorRoles?: readonly string[]
  when?: readonly FieldCondition[]
  recipients: RecipientSpec
  severity?: 'info' | 'warning' | 'critical'
}

export interface Roster {
  roles?: Readonly<Record<string, string>>
  vaultOwner?: Readonly<Record<string, string>>
  assignees?: Readonly<Record<string, readonly string[]>>
}

/** Spec § 4: references only — deliberately no slot for field values. */
export interface NotificationIntent {
  ruleId: string
  actorId: string
  actorRole?: string
  op: WriteOp
  ref: { vaultId: string; collection: string; recordId: string; version: number }
  recipients: readonly string[]
  severity?: 'info' | 'warning' | 'critical'
  ts: number
}

export type NotificationSink = (intent: NotificationIntent) => void | Promise<void>
```

A rule is plain JSON — serializable, diffable, and safe to store fleet-visible
in the notifications vault as spec § 4 requires. Rules carry no functions.

## Matching semantics

All rule predicates AND together; every `when` condition must hold.

| Situation | Rule |
|---|---|
| Omitted `ops` / `vaults` / `actorRoles` / `when` | no constraint on that axis |
| `create` | `before` absent — every path reads `undefined` |
| `delete` | `after` absent — every path reads `undefined` |
| `changed: true` | `before[path]` and `after[path]` differ (deep compare) |
| `changed: false` | they are equal |
| `from` / `to` | compared against `before[path]` / `after[path]` |
| `equals` | compared against `after[path]` |
| Several rules match one event | one intent **per** matching rule |
| Recipients resolve empty | **no intent emitted** |
| Actor is among the recipients | actor removed; recipients deduped |

`actorRole` comes from `roster.roles[event.userId]`; a rule constraining
`actorRoles` cannot match when the roster does not know the actor.

Value comparison (`changed`, `from`, `to`, `equals`) is **structural deep
equality**: `Object.is` for primitives, recursive element/own-enumerable-key
comparison for arrays and plain objects, key order insignificant. Not
JSON-string comparison — that would make key order significant and would throw
on cyclic values.

### Payload minimization

`NotificationIntent` has no field-value slot at the type level, which is what
spec § 4 asks for. It is additionally enforced behaviourally: a test asserts
that a rule matching on specific values emits an intent whose serialized JSON
contains no occurrence of those values. That catches a later refactor that
"helpfully" attaches the diff.

## Engine surface

```ts
export interface RuleEngineOptions {
  rules: readonly NotificationRule[]
  sink: NotificationSink
  onError?: (err: unknown, ctx: { phase: 'match' | 'sink'; ruleId?: string }) => void
}

export class NotificationRuleEngine {
  constructor(opts: RuleEngineOptions)

  /** Pure — no I/O. The intents this event would emit. */
  evaluate(event: WriteEvent, roster?: Roster): NotificationIntent[]

  /** Wires `db.onAfterWrite`. Returns the hub's Unsubscribe. */
  attach(db: Noydb, opts?: { roster?: Roster }): Unsubscribe
}
```

Shipped as a plain exported class, matching `InsightAutoPush`; no factory
wrapper.

The roster is a snapshot supplied at `attach` time. Resolution is a synchronous
pure lookup, so evaluation stays deterministic and testable. Roster freshness
is the caller's responsibility — the caller already holds the keyring and the
registry, and is the one place that knows fleet identities. To refresh, detach
and re-attach. Note that the roster object is held by reference, so mutating
it in place is observed by subsequent writes; replacing it with a new object
still requires detach and re-attach.

## Error handling

Best-effort throughout, matching `onAfterWrite`'s documented "warned, not
thrown" semantics and the `InsightAutoPush` precedent:

- A malformed rule is caught per-rule, reported via
  `onError({ phase: 'match', ruleId })`, and skipped — one bad rule never
  suppresses the others.
- A sink throw or rejection reaches `onError({ phase: 'sink' })` and never
  propagates into the write path.
- Default `onError` warns on the console with a `[klum-db]` prefix.

A notification failure must never fail, roll back, or block a client write.

## Testing

TDD; tests written before implementation.

**`__tests__/notification-rules.test.ts`** — pure, no vault:

- op / vault / `actorRoles` filters, including omitted-means-any
- `changed`, `from`/`to`, `equals`; nested dotted path
- `create` (absent `before`) and `delete` (absent `after`)
- several matching rules → several intents
- each `RecipientSpec` kind resolved against a roster
- empty recipients → no intent; self-suppression; dedup
- payload minimization: matched values absent from the serialized intent
- a malformed rule is skipped and reported, siblings still evaluate

**`__tests__/notification-engine.test.ts`** — integration, real in-memory hub:

- `toMemory()` + `withCargo()` vault; `attach`; real `put` / `delete` produce
  the expected intents
- a throwing sink does **not** fail the write
- the returned `Unsubscribe` stops emission

## Follow-ups (not this slice)

- #38 supplies a persisting sink and the inbox.
- Upstream noy-db issue: export `WriteEvent` from `/cargo` by name.
- Portal-actor coverage, per spec § 0, when a real portal-write rule appears.
