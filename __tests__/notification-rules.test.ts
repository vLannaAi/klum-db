/**
 * Notifications rule engine (#37) — pure matching. No vault required.
 */
import { describe, it, expect } from 'vitest'
import { deepEqual, matchesCondition } from '../src/notifications/match.js'

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
