/**
 * @klum-db/lobby notifications — pure matching + recipient resolution (#37).
 *
 * No I/O, no vault access. Every export is a total function over plain
 * data, so rule behaviour is testable without a fleet.
 *
 * @module
 */
import { readPath } from '@noy-db/hub/cargo'
import type { FieldCondition } from './types.js'

/**
 * Structural deep equality. `Object.is` for primitives; recursive
 * comparison for arrays and plain objects with key order insignificant.
 * Deliberately not JSON-string comparison — that makes key order
 * significant and throws on cyclic values.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  const aArr = Array.isArray(a)
  if (aArr !== Array.isArray(b)) return false
  if (aArr) {
    const x = a as unknown[]
    const y = b as unknown[]
    return x.length === y.length && x.every((v, i) => deepEqual(v, y[i]))
  }
  const x = a as Record<string, unknown>
  const y = b as Record<string, unknown>
  const kx = Object.keys(x)
  if (kx.length !== Object.keys(y).length) return false
  return kx.every((k) => Object.prototype.hasOwnProperty.call(y, k) && deepEqual(x[k], y[k]))
}

/**
 * Does one field condition hold for this write? All present clauses AND
 * together. An absent `before`/`after` (create/delete) reads as `undefined`.
 */
export function matchesCondition(cond: FieldCondition, before: unknown, after: unknown): boolean {
  const prior = readPath(before, cond.field)
  const next = readPath(after, cond.field)
  if (cond.changed !== undefined && !deepEqual(prior, next) !== cond.changed) return false
  if ('from' in cond && !deepEqual(prior, cond.from)) return false
  if ('to' in cond && !deepEqual(next, cond.to)) return false
  if ('equals' in cond && !deepEqual(next, cond.equals)) return false
  return true
}
