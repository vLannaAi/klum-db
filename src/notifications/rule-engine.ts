/**
 * @klum-db/lobby notifications — the actor-side rule engine (#37).
 *
 * Evaluates declarative rules against the writing session's own
 * `onAfterWrite` events and emits reference-only intents to a sink.
 * Never opens a vault, never writes a record, never throws into the
 * write path. Delivery is #38's job.
 *
 * @module
 */
import type { WriteHook } from '@noy-db/hub/cargo'
import { matchesRule, resolveRecipients } from './match.js'
import type {
  NotificationIntent,
  NotificationRule,
  NotificationSink,
  Roster,
} from './types.js'

/**
 * `/cargo` publishes `WriteHook` but not `WriteEvent` by name, so the
 * event shape is derived structurally rather than by reaching into hub
 * internals. Drop this alias once noy-db exports `WriteEvent`.
 */
export type WriteEvent = Parameters<WriteHook>[0]

export interface ErrorContext {
  phase: 'match' | 'sink'
  ruleId?: string
}

export interface RuleEngineOptions {
  rules: readonly NotificationRule[]
  sink: NotificationSink
  onError?: (err: unknown, ctx: ErrorContext) => void
}

const warn = (err: unknown, ctx: ErrorContext): void => {
  console.warn(`[klum-db] notification rule ${ctx.phase} failed${ctx.ruleId ? ` for "${ctx.ruleId}"` : ''}:`, err)
}

export class NotificationRuleEngine {
  private readonly rules: readonly NotificationRule[]
  private readonly sink: NotificationSink
  private readonly onError: (err: unknown, ctx: ErrorContext) => void

  constructor(opts: RuleEngineOptions) {
    this.rules = opts.rules
    this.sink = opts.sink
    this.onError = opts.onError ?? warn
  }

  /**
   * Pure — no I/O. The intents this event would emit. A rule that throws
   * is reported and skipped; its siblings still evaluate.
   */
  evaluate(event: WriteEvent, roster: Roster = {}): NotificationIntent[] {
    const actorRole = roster.roles?.[event.userId]
    const intents: NotificationIntent[] = []

    for (const rule of this.rules) {
      try {
        const matched = matchesRule(rule, {
          vaultId: event.vault,
          collection: event.collection,
          op: event.op,
          ...(actorRole !== undefined ? { actorRole } : {}),
          before: event.before,
          after: event.after,
        })
        if (!matched) continue

        // Suppress the actor's own write, then dedupe.
        const recipients = [
          ...new Set(
            resolveRecipients(rule.recipients, { vaultId: event.vault, roster }).filter(
              (id) => id !== event.userId,
            ),
          ),
        ]
        // An intent nobody receives is not worth emitting.
        if (recipients.length === 0) continue

        const intent: NotificationIntent = {
          ruleId: rule.id,
          actorId: event.userId,
          op: event.op,
          ref: {
            vaultId: event.vault,
            collection: event.collection,
            recordId: event.docId,
            version: event.version,
          },
          recipients,
          ts: event.timestamp,
        }
        if (actorRole !== undefined) intent.actorRole = actorRole
        if (rule.severity !== undefined) intent.severity = rule.severity
        intents.push(intent)
      } catch (err) {
        this.onError(err, { phase: 'match', ruleId: rule?.id })
      }
    }

    return intents
  }
}
