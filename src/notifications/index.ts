/**
 * @klum-db/lobby notifications (#37) — actor-side rule engine.
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
