/**
 * @klum-db/lobby notifications (#37 + #38) — actor-side rule engine and
 * in-app delivery (sink + inbox).
 *
 * @module
 */
export { NotificationRuleEngine } from './rule-engine.js'
export type { RuleEngineOptions, ErrorContext, WriteEvent } from './rule-engine.js'
export { matchesRule, matchesCondition, resolveRecipients, deepEqual } from './match.js'
export type { RuleMatchContext } from './match.js'
export type {
  WriteOp,
  Severity,
  FieldCondition,
  RecipientSpec,
  NotificationRule,
  Roster,
  NotificationRef,
  NotificationIntent,
  NotificationSink,
} from './types.js'
export { openNotifications } from './open.js'
export type { NotificationsGroupRef, OpenNotificationsOptions, NotificationsHandle } from './open.js'
export { createNotificationSink } from './delivery.js'
export type { NotificationWriter, SinkOptions } from './delivery.js'
export { NotificationInbox } from './inbox.js'
export type { InboxStore, ListOptions } from './inbox.js'
export {
  NOTIFICATIONS_COLLECTION, NOTIFICATIONS_REGISTRY_COLLECTION,
  notificationsVaultName, deriveNotificationId,
} from './record.js'
export type { NotificationRecord, NotificationsRegistryRow } from './record.js'
