/**
 * @category capability
 * Distributed partial-reduce over the kernel Reducer protocol (#8). Each shard
 * folds its own records to a partial STATE; states are merged centrally and
 * finalized once — identical to central `reduceRecords` over the union, but
 * without materializing the union. Used by the scalar `.aggregate().run()` path
 * when every reducer exposes `merge` (else the caller falls back to central).
 */
import type { ReduceResult, ReduceSpec } from '@noy-db/hub/cargo'

/**
 * Structural view of the kernel `Reducer` protocol. `Reducer` itself is not
 * exported on the `@noy-db/hub/cargo` boundary, so we model the shape locally
 * (an `ReduceSpec` value carries exactly these methods).
 */
interface ReducerLike {
  init(): unknown
  step(state: unknown, record: unknown): unknown
  finalize(state: unknown): unknown
  /** Optional — associative + commutative with init() as identity (kernel contract). */
  merge?(a: unknown, b: unknown): unknown
}

/** One opaque reducer state per spec key. */
export type PartialState = Record<string, unknown>

/** True iff every reducer in the spec exposes a callable `merge` (safe to partial-reduce). */
export function canPartialReduce(spec: ReduceSpec): boolean {
  return Object.values(spec).every((r) => typeof (r as ReducerLike).merge === 'function')
}

/** Fold one shard's records to a partial state per spec key (no finalize). */
export function reduceToPartial(records: readonly unknown[], spec: ReduceSpec): PartialState {
  const out: PartialState = {}
  for (const [key, reducer] of Object.entries(spec)) {
    const r = reducer as ReducerLike
    let state = r.init()
    for (const rec of records) state = r.step(state, rec)
    out[key] = state
  }
  return out
}

/**
 * Merge partial states across shards per spec key, seeded with each reducer's
 * `init()` (the merge identity) so an empty `partials` array yields the
 * empty-aggregate state.
 */
export function mergePartials(spec: ReduceSpec, partials: readonly PartialState[]): PartialState {
  const out: PartialState = {}
  for (const [key, reducer] of Object.entries(spec)) {
    const r = reducer as ReducerLike
    let acc = r.init()
    for (const p of partials) acc = r.merge!(acc, p[key])
    out[key] = acc
  }
  return out
}

/** Finalize a merged state into the user-visible aggregate result. */
export function finalizePartial<Spec extends ReduceSpec>(spec: Spec, merged: PartialState): ReduceResult<Spec> {
  const out: Record<string, unknown> = {}
  for (const [key, reducer] of Object.entries(spec)) {
    out[key] = (reducer as ReducerLike).finalize(merged[key])
  }
  return out as ReduceResult<Spec>
}
