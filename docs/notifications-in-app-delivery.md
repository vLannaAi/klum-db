# Notifications in-app delivery (#38) — design

> Implements slice 2 of milestone 4, per the accepted spec
> [`docs/notifications-cross-actor.md`](./notifications-cross-actor.md) (#36).
> Consumes the rule engine from [`docs/notifications-rule-engine.md`](./notifications-rule-engine.md) (#37).
> Status: **approved 2026-08-08.**

## Scope

`#38` supplies the **sink** that #37's engine emits into, plus the storage and
read side of delivery:

- the per-fleet notifications vault (ensure + register)
- the sink: intent → notification records
- the inbox: list, unread count, dismiss
- expiry semantics

Explicitly **out of scope**: push transport (#39), rule evaluation (#37),
and granting fleet actors read access to the notifications vault (see
*Consumer requirement* below).

## Entry point

```ts
const { sink, inbox, vaultId } = await lobby.openNotifications(group)

// wire to the #37 engine
const engine = new NotificationRuleEngine({ rules, sink })
engine.attach(db, { roster })

// read side
const mine = await inbox.list({ recipient: 'u_ben' })
await inbox.dismiss(mine[0].id)
```

`openNotifications(group, opts?)` ensures the vault exists (creating and
registering it on first call, mirroring the portal pair's ensure-shard step),
then returns the handle. Idempotent: a second call reuses the existing vault.

Options: `defaultTtlMs?: number` — when set, every written record gets
`expiresAt = createdAt + defaultTtlMs`. Rules carry no TTL field in #37 and
none is added speculatively.

## Fan-out: one record per recipient

A #37 intent carries `recipients: string[]`. The sink **fans out on write**:
N recipients produce N records, each owned by exactly one reader.

This is the decision the rest of the design rests on, and it is what keeps
#38 simple:

- **Dismissal converges for free.** Each record has one owner, so two of that
  user's devices dismissing the same notification write the same field on the
  same record. Ordinary record-level last-write-wins converges. Dismissing on
  a phone cannot resurrect on a laptop.
- **No CRDT.** Issue #38 assumed `crdt: 'lww-map'` would be needed for
  `dismissedAt`. It is not, under fan-out — and consequently **consumers do
  not need `crdtStrategy: withCrdt()`**. That assumption in the issue is
  superseded by this document.
- **The inbox is one query**, filtered by `recipient`.

The cost is N× records for a broadcast rule. Accepted: fleet recipient sets
are small (tens of actors), and the alternative buys storage savings at the
price of a CRDT dependency plus a per-recipient dismissal map.

## Registry placement — do NOT register as a shard

Spec § 1 says the notifications vault is "registered in the StateManagement
registry like any shard." Taken literally that is **unsafe**.

`VaultRegistryRow` is shard-shaped (`partitionKey`, `templateName`,
`schemaVersion`, `group`), and `openVaultGroup` fans out across the registry
rows belonging to a group. A notifications vault registered with
`group: '<group>'` would be treated as a shard: swept into `crossShardJoin`,
`queryAcrossLive` and `aggregateAcross`, and — worst — into `rolloutSchema`,
which would attempt a client-schema cutover against a vault of notifications.

**Decision: register in a separate `notifications-registry` collection** in
the StateManagement vault, never in `vault-registry`.

The fleet keeps one authoritative record of what exists, and the shard
fan-out physically cannot see it. This is the mirror image of the Insight
Vault's guard, which refuses a `target.vault` that is the group or one of its
shards (`vault-group.ts:325-329`) — and it follows that guard's better
instinct of enforcing at **registration** time rather than query time. A
query-time filter must be remembered at every call site and fails open the
moment a new fan-out path is added; a vault that was never in the shard
registry has no code path to forget.

Row shape:

```ts
export interface NotificationsRegistryRow {
  readonly vaultId: string
  readonly group: string
  readonly createdAt: number
}
```

Vault name: `notifications--<group>`.

## The record

```ts
export interface NotificationRecord {
  id: string
  recipient: string
  ruleId: string
  actorId: string
  actorRole?: string
  op: WriteOp
  ref: NotificationRef        // { vaultId, collection, recordId, version }
  severity?: Severity
  createdAt: number
  expiresAt?: number
  dismissedAt?: number | null
}
```

Every field carried from the intent is a **reference**. Payload minimization
(spec § 4) survives the hop into storage — which is exactly the point where
it would be easiest to quietly break, since a "helpful" denormalization of
the changed value into the record would make rendering easier and the
security property false. A test asserts matched field values never appear in
a stored record.

## Idempotency

```
id = sha256Hex(`${ruleId}|${ref.vaultId}|${ref.collection}|${ref.recordId}|${ref.version}|${recipient}`)
```

Deterministic, so re-delivering the same intent overwrites rather than
duplicating. It keys on the **full ref plus recipient**, never on `ruleId`
alone — the trap flagged in #37's branch review, where duplicate rule ids
both fire and their intents are indistinguishable by rule id. Two distinct
rules matching the same write produce different ids and therefore two
notifications, which is correct: they are two different reasons to be told.

Every component is a reference already present in the record, so the derived
id leaks nothing new. `sha256Hex` comes from `@noy-db/hub/cargo`.

## The inbox

```ts
export interface NotificationInbox {
  list(opts: { recipient: string; includeDismissed?: boolean; now?: number }): Promise<NotificationRecord[]>
  unreadCount(recipient: string, opts?: { now?: number }): Promise<number>
  dismiss(id: string, opts?: { at?: number }): Promise<void>
}
```

`list` returns records for `recipient`, newest first, excluding dismissed
(unless `includeDismissed`) and excluding expired.

**Expiry is a read-time filter only.** `expiresAt` is stored and the query
excludes rows past it. There is no sweeper: no scheduler, no background
writes, no cross-device contention. An expired notification simply stops
appearing. Bounding storage is a separate operational concern, deliberately
not solved here.

`now` and `at` are injectable so expiry and dismissal are testable without
real timers.

## Consumer requirement — grants are the caller's

Recipients need a grant on the notifications vault to read it (spec § 2, the
team keyring; `teamStrategy: withTeam()` on the granting session).

`openNotifications` ensures and registers the vault but **does not grant**.
Fleet membership has real identity side effects and does not belong to a
delivery call. The handle exposes `vaultId` so callers grant explicitly.
This goes in README's *Consumer requirements* alongside the existing
`cargoStrategy` / `searchStrategy` / `teamStrategy` notes.

## Module layout

Extends the existing `src/notifications/` from #37.

| File | Purpose | Depends on |
|---|---|---|
| `record.ts` | `NotificationRecord`, `NotificationsRegistryRow`, id derivation | `types.ts`, `/cargo` (`sha256Hex`) |
| `delivery.ts` | `createNotificationSink(collection, opts)` — fan-out | `record.ts` |
| `inbox.ts` | `NotificationInbox` — list / unreadCount / dismiss | `record.ts` |
| `open.ts` | ensure vault + register + assemble the handle | all of the above |

`Lobby.openNotifications` in `src/index.ts` delegates to `open.ts`, matching
the existing `openVaultGroup` / `openReadModel` / `openStateManagementVault`
shape. Follow `openReadModel`'s convention specifically (`src/index.ts:202`):
it delegates via a **dynamic** `await import('./federation/read-model.js')`,
keeping the module out of the main bundle for consumers who never call it.
`openNotifications` does the same with `./notifications/open.js`.

Boundary unchanged: `@noy-db/hub/cargo` only.

## Error handling

The sink is called from #37's `attach()` hook, which swallows sink errors
into `onError` — so a write failure here never reaches the user's business
write. That containment already exists and is not re-implemented; the sink
simply does not defend against its own caller.

`openNotifications` **does** throw on failure to ensure or register the
vault: it is an explicit setup call, not a write-path callback, and failing
silently would leave notifications disappearing with no signal.

## Testing

Pure (no vault):

- id derivation is deterministic and varies with each component
- fan-out arity: N recipients → N records, one per recipient
- inbox filtering: dismissed excluded, `includeDismissed` includes, expired
  excluded, `now` respected
- payload minimization: matched field values absent from a stored record

Integration (real in-memory hub vault, `memoryStore` from
`__tests__/helpers/two-shard-group.ts`):

- ensure → write via sink → `list` → `dismiss` → `list` reflects it
- a second `openNotifications` reuses the existing vault, creates no duplicate
- the notifications vault does **not** appear in the group's shard fan-out
  (the registry-placement guarantee, asserted rather than assumed)
- end-to-end with #37: `engine.attach` → real write → record readable in the inbox

## Follow-ups (not this slice)

- #39 push transport: content-free wake-up; this slice's records are what it
  wakes a device to read.
- Storage bounding for expired records, if it ever becomes real.
