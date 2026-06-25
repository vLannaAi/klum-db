/**
 * @category capability
 * Distributed partial-reduce over the kernel Reducer protocol (#8). Each shard
 * folds its own records to a partial STATE; states are merged centrally and
 * finalized once — identical to central `reduceRecords` over the union, but
 * without materializing the union. Used by the scalar `.aggregate().run()` path
 * when every reducer exposes `merge` (else the caller falls back to central).
 */
import type { AggregateResult, AggregateSpec } from '@noy-db/hub/kernel'

/**
 * Structural view of the kernel `Reducer` protocol. `Reducer` itself is not
 * exported on the `@noy-db/hub/kernel` boundary, so we model the shape locally
 * (an `AggregateSpec` value carries exactly these methods).
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
export function canPartialReduce(spec: AggregateSpec): boolean {
  return Object.values(spec).every((r) => typeof (r as ReducerLike).merge === 'function')
}

/** Fold one shard's records to a partial state per spec key (no finalize). */
export function reduceToPartial(records: readonly unknown[], spec: AggregateSpec): PartialState {
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
export function mergePartials(spec: AggregateSpec, partials: readonly PartialState[]): PartialState {
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
export function finalizePartial<Spec extends AggregateSpec>(spec: Spec, merged: PartialState): AggregateResult<Spec> {
  const out: Record<string, unknown> = {}
  for (const [key, reducer] of Object.entries(spec)) {
    out[key] = (reducer as ReducerLike).finalize(merged[key])
  }
  return out as AggregateResult<Spec>
}
