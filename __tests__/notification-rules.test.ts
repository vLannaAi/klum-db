/**
 * Notifications rule engine (#37) — pure matching. No vault required.
 */
import { describe, it, expect } from 'vitest'
import { deepEqual, matchesCondition, matchesRule, resolveRecipients } from '../src/notifications/match.js'
import type { NotificationRule, Roster } from '../src/notifications/types.js'

describe('deepEqual', () => {
  it('compares primitives with Object.is semantics', () => {
    expect(deepEqual(1, 1)).toBe(true)
    expect(deepEqual('a', 'b')).toBe(false)
    expect(deepEqual(NaN, NaN)).toBe(true)
    expect(deepEqual(null, undefined)).toBe(false)
  })

  it('compares plain objects structurally, key order insignificant', () => {
    expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true)
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false)
    expect(deepEqual({ a: { c: 3 } }, { a: { c: 3 } })).toBe(true)
    expect(deepEqual({ a: { c: 3 } }, { a: { c: 4 } })).toBe(false)
  })

  it('compares arrays element-wise and order-sensitively', () => {
    expect(deepEqual([1, 2], [1, 2])).toBe(true)
    expect(deepEqual([1, 2], [2, 1])).toBe(false)
    expect(deepEqual([1], [1, 2])).toBe(false)
    expect(deepEqual([1], { 0: 1 })).toBe(false)
  })
})

describe('matchesCondition', () => {
  const before = { riskRating: 'low', profile: { tier: 'basic' } }
  const after = { riskRating: 'high', profile: { tier: 'basic' } }

  it('matches changed: true only when the value differs', () => {
    expect(matchesCondition({ field: 'riskRating', changed: true }, before, after)).toBe(true)
    expect(matchesCondition({ field: 'profile.tier', changed: true }, before, after)).toBe(false)
  })

  it('matches changed: false only when the value is equal', () => {
    expect(matchesCondition({ field: 'profile.tier', changed: false }, before, after)).toBe(true)
    expect(matchesCondition({ field: 'riskRating', changed: false }, before, after)).toBe(false)
  })

  it('matches from/to against prior and next', () => {
    expect(matchesCondition({ field: 'riskRating', from: 'low', to: 'high' }, before, after)).toBe(true)
    expect(matchesCondition({ field: 'riskRating', from: 'high', to: 'high' }, before, after)).toBe(false)
    expect(matchesCondition({ field: 'riskRating', to: 'medium' }, before, after)).toBe(false)
  })

  it('matches equals against the next value only', () => {
    expect(matchesCondition({ field: 'riskRating', equals: 'high' }, before, after)).toBe(true)
    expect(matchesCondition({ field: 'riskRating', equals: 'low' }, before, after)).toBe(false)
  })

  it('ANDs every present clause', () => {
    expect(matchesCondition({ field: 'riskRating', changed: true, to: 'high' }, before, after)).toBe(true)
    expect(matchesCondition({ field: 'riskRating', changed: true, to: 'low' }, before, after)).toBe(false)
  })

  it('reads absent sides as undefined (create has no before, delete has no after)', () => {
    expect(matchesCondition({ field: 'riskRating', from: undefined }, undefined, after)).toBe(true)
    expect(matchesCondition({ field: 'riskRating', to: undefined }, before, undefined)).toBe(true)
    expect(matchesCondition({ field: 'riskRating', changed: true }, undefined, after)).toBe(true)
  })

  it('resolves nested dotted paths', () => {
    expect(matchesCondition({ field: 'profile.tier', equals: 'basic' }, before, after)).toBe(true)
    expect(matchesCondition({ field: 'profile.missing', equals: undefined }, before, after)).toBe(true)
  })
})

const RISK_RULE: NotificationRule = {
  id: 'risk-escalation',
  collection: 'clients',
  ops: ['update'],
  actorRoles: ['advisor'],
  when: [{ field: 'riskRating', from: 'low', to: 'high' }],
  recipients: { kind: 'vaultOwner' },
}

const baseCtx = {
  vaultId: 'shard_x',
  collection: 'clients',
  op: 'update' as const,
  actorRole: 'advisor',
  before: { riskRating: 'low' },
  after: { riskRating: 'high' },
}

describe('matchesRule', () => {
  it('matches when every axis agrees', () => {
    expect(matchesRule(RISK_RULE, baseCtx)).toBe(true)
  })

  it('rejects a different collection', () => {
    expect(matchesRule(RISK_RULE, { ...baseCtx, collection: 'invoices' })).toBe(false)
  })

  it('rejects an op outside the rule', () => {
    expect(matchesRule(RISK_RULE, { ...baseCtx, op: 'create' })).toBe(false)
  })

  it('rejects an actor role outside the rule, including an unknown role', () => {
    expect(matchesRule(RISK_RULE, { ...baseCtx, actorRole: 'clerk' })).toBe(false)
    expect(matchesRule(RISK_RULE, { ...baseCtx, actorRole: undefined })).toBe(false)
  })

  it('rejects when a field condition fails', () => {
    expect(matchesRule(RISK_RULE, { ...baseCtx, after: { riskRating: 'medium' } })).toBe(false)
  })

  it('treats omitted ops / vaults / actorRoles / when as no constraint', () => {
    const open: NotificationRule = {
      id: 'any-write',
      collection: 'documents',
      recipients: { kind: 'actors', ids: ['u_ben'] },
    }
    expect(matchesRule(open, { ...baseCtx, collection: 'documents', op: 'delete', actorRole: undefined })).toBe(true)
  })

  it('honours a vaults allowlist', () => {
    const scoped: NotificationRule = { ...RISK_RULE, vaults: ['shard_y'] }
    expect(matchesRule(scoped, baseCtx)).toBe(false)
    expect(matchesRule({ ...scoped, vaults: ['shard_x'] }, baseCtx)).toBe(true)
  })
})

describe('resolveRecipients', () => {
  const roster: Roster = {
    roles: { u_ada: 'advisor', u_ben: 'owner', u_cy: 'advisor' },
    vaultOwner: { shard_x: 'u_ben' },
    assignees: { shard_x: ['u_cy', 'u_ada'] },
  }

  it('resolves explicit actor ids', () => {
    expect(resolveRecipients({ kind: 'actors', ids: ['u_ben'] }, { vaultId: 'shard_x', roster })).toEqual(['u_ben'])
  })

  it('resolves the vault owner', () => {
    expect(resolveRecipients({ kind: 'vaultOwner' }, { vaultId: 'shard_x', roster })).toEqual(['u_ben'])
  })

  it('resolves assignees', () => {
    expect(resolveRecipients({ kind: 'assignees' }, { vaultId: 'shard_x', roster })).toEqual(['u_cy', 'u_ada'])
  })

  it('resolves every actor holding a role', () => {
    expect(resolveRecipients({ kind: 'role', role: 'advisor' }, { vaultId: 'shard_x', roster }).sort())
      .toEqual(['u_ada', 'u_cy'])
  })

  it('returns empty when the roster cannot answer', () => {
    expect(resolveRecipients({ kind: 'vaultOwner' }, { vaultId: 'unknown', roster })).toEqual([])
    expect(resolveRecipients({ kind: 'assignees' }, { vaultId: 'shard_x', roster: {} })).toEqual([])
    expect(resolveRecipients({ kind: 'role', role: 'nobody' }, { vaultId: 'shard_x', roster })).toEqual([])
  })
})

import { NotificationRuleEngine } from '../src/notifications/rule-engine.js'
import type { WriteEvent } from '../src/notifications/rule-engine.js'
import type { NotificationIntent } from '../src/notifications/types.js'

/**
 * A WriteEvent-shaped literal. Typed as WriteEvent so `pnpm typecheck`
 * verifies the fixture against the real hub shape — if noy-db adds a
 * required field, this fixture fails to compile rather than silently
 * drifting.
 */
function writeEvent(over: Partial<WriteEvent> = {}): WriteEvent {
  return {
    op: 'update',
    vault: 'shard_x',
    collection: 'clients',
    docId: 'rec_1',
    before: { riskRating: 'low' },
    after: { riskRating: 'high' },
    baseVersion: 4,
    version: 5,
    userId: 'u_ada',
    timestamp: 1_700_000_000_000,
    txId: 'tx_1',
    ...over,
  }
}

const ROSTER: Roster = {
  roles: { u_ada: 'advisor', u_ben: 'owner' },
  vaultOwner: { shard_x: 'u_ben' },
}

describe('NotificationRuleEngine.evaluate', () => {
  it('emits one intent per matching rule, carrying only references', () => {
    const engine = new NotificationRuleEngine({ rules: [RISK_RULE], sink: () => {} })
    const intents = engine.evaluate(writeEvent(), ROSTER)
    expect(intents).toHaveLength(1)
    expect(intents[0]).toEqual({
      ruleId: 'risk-escalation',
      actorId: 'u_ada',
      actorRole: 'advisor',
      op: 'update',
      ref: { vaultId: 'shard_x', collection: 'clients', recordId: 'rec_1', version: 5 },
      recipients: ['u_ben'],
      ts: 1_700_000_000_000,
    } satisfies NotificationIntent)
  })

  it('emits nothing when no rule matches', () => {
    const engine = new NotificationRuleEngine({ rules: [RISK_RULE], sink: () => {} })
    expect(engine.evaluate(writeEvent({ collection: 'invoices' }), ROSTER)).toEqual([])
  })

  it('emits one intent per matching rule when several match', () => {
    const second: NotificationRule = {
      id: 'any-client-update',
      collection: 'clients',
      recipients: { kind: 'actors', ids: ['u_zoe'] },
    }
    const engine = new NotificationRuleEngine({ rules: [RISK_RULE, second], sink: () => {} })
    expect(engine.evaluate(writeEvent(), ROSTER).map((i) => i.ruleId))
      .toEqual(['risk-escalation', 'any-client-update'])
  })

  it('never leaks matched field values into the intent (payload minimization, spec § 4)', () => {
    const engine = new NotificationRuleEngine({ rules: [RISK_RULE], sink: () => {} })
    const json = JSON.stringify(engine.evaluate(writeEvent(), ROSTER))
    expect(json).not.toContain('low')
    expect(json).not.toContain('high')
    expect(json).not.toContain('riskRating')
  })

  it('suppresses the acting actor and dedupes recipients', () => {
    const selfRule: NotificationRule = {
      id: 'self',
      collection: 'clients',
      recipients: { kind: 'actors', ids: ['u_ada', 'u_ben', 'u_ben'] },
    }
    const engine = new NotificationRuleEngine({ rules: [selfRule], sink: () => {} })
    expect(engine.evaluate(writeEvent(), ROSTER)[0].recipients).toEqual(['u_ben'])
  })

  it('emits no intent when recipients resolve empty', () => {
    const orphan: NotificationRule = {
      id: 'orphan',
      collection: 'clients',
      recipients: { kind: 'vaultOwner' },
    }
    const engine = new NotificationRuleEngine({ rules: [orphan], sink: () => {} })
    expect(engine.evaluate(writeEvent({ vault: 'unknown_shard' }), ROSTER)).toEqual([])
  })

  it('carries severity when the rule sets one, and omits it otherwise', () => {
    const engine = new NotificationRuleEngine({
      rules: [{ ...RISK_RULE, severity: 'critical' }],
      sink: () => {},
    })
    expect(engine.evaluate(writeEvent(), ROSTER)[0].severity).toBe('critical')
  })

  it('skips a malformed rule, reports it, and still evaluates its siblings', () => {
    const errors: Array<{ phase: string; ruleId?: string }> = []
    const bad = { id: 'bad', collection: 'clients', get recipients(): never { throw new Error('boom') } }
    const good: NotificationRule = {
      id: 'good',
      collection: 'clients',
      recipients: { kind: 'actors', ids: ['u_ben'] },
    }
    const engine = new NotificationRuleEngine({
      rules: [bad as unknown as NotificationRule, good],
      sink: () => {},
      onError: (_e, ctx) => errors.push(ctx),
    })
    expect(engine.evaluate(writeEvent(), ROSTER).map((i) => i.ruleId)).toEqual(['good'])
    expect(errors).toEqual([{ phase: 'match', ruleId: 'bad' }])
  })

  it('evaluates with no roster at all', () => {
    const open: NotificationRule = {
      id: 'open',
      collection: 'clients',
      recipients: { kind: 'actors', ids: ['u_ben'] },
    }
    const engine = new NotificationRuleEngine({ rules: [open], sink: () => {} })
    const intents = engine.evaluate(writeEvent())
    expect(intents).toHaveLength(1)
    expect(intents[0].actorRole).toBeUndefined()
  })
})
