/**
 * @klum-db/lobby notifications — rule / intent types (#37).
 *
 * A rule is plain JSON: serializable, diffable, and safe to store
 * fleet-visible in the notifications vault (spec § 4). Rules carry no
 * functions.
 *
 * @module
 */

export type WriteOp = 'create' | 'update' | 'delete'

export type Severity = 'info' | 'warning' | 'critical'

/** A predicate over one field path, compared across the write's before/after. */
export interface FieldCondition {
  /** Dotted path, read with hub's `readPath` — same semantics as the query DSL. */
  field: string
  /** True: prior and next differ. False: they are equal. */
  changed?: boolean
  /** Prior value equals this. */
  from?: unknown
  /** Next value equals this. */
  to?: unknown
  /** Next value equals this, regardless of prior. */
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
  /** Defaults to all three ops. */
  ops?: readonly WriteOp[]
  /** Defaults to any vault. */
  vaults?: readonly string[]
  /** Defaults to any role. */
  actorRoles?: readonly string[]
  /** Every condition must hold. Defaults to no field constraint. */
  when?: readonly FieldCondition[]
  recipients: RecipientSpec
  severity?: Severity
}

/** A caller-supplied identity snapshot. Resolution is a pure lookup. */
export interface Roster {
  roles?: Readonly<Record<string, string>>
  vaultOwner?: Readonly<Record<string, string>>
  assignees?: Readonly<Record<string, readonly string[]>>
}

export interface NotificationRef {
  vaultId: string
  collection: string
  recordId: string
  version: number
}

/**
 * Spec § 4: references only. There is deliberately NO slot for field
 * values, diffs, or record snapshots — rendering happens client-side by
 * dereferencing `ref`, which succeeds only for vaults the reader can
 * already open. Do not add one.
 */
export interface NotificationIntent {
  ruleId: string
  actorId: string
  actorRole?: string
  op: WriteOp
  ref: NotificationRef
  recipients: readonly string[]
  severity?: Severity
  ts: number
}

export type NotificationSink = (intent: NotificationIntent) => void | Promise<void>
