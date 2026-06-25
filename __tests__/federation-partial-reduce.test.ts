/** Pure partial-reduce helpers (#8) — driven directly, no federation harness. */
import { describe, it, expect } from 'vitest'
import { reduceRecords } from '@noy-db/hub/kernel'
import { sum, count, avg, min, max } from '@noy-db/hub/aggregate'
import { canPartialReduce, reduceToPartial, mergePartials, finalizePartial } from '../src/federation/partial-reduce.js'

interface Rec extends Record<string, unknown> { amount: number }
const shards: Rec[][] = [
  [{ amount: 100 }, { amount: 250 }, { amount: 50 }],
  [{ amount: 70 }],
  [{ amount: 900 }, { amount: 10 }],
]
const spec = { total: sum('amount'), n: count(), mean: avg('amount'), lo: min('amount'), hi: max('amount') }

function partialEndToEnd(shardSets: Rec[][]) {
  const partials = shardSets.map((rows) => reduceToPartial(rows, spec))
  return finalizePartial(spec, mergePartials(spec, partials))
}

describe('partial-reduce helpers', () => {
  it('canPartialReduce is true when every reducer has merge, false otherwise', () => {
    expect(canPartialReduce(spec)).toBe(true)
    const noMerge = { init: () => 0, step: (s: number, r: unknown) => s + (r as Rec).amount, finalize: (s: number) => s }
    expect(canPartialReduce({ x: noMerge } as never)).toBe(false)
  })

  it('partial end-to-end equals central reduceRecords (avg-correct, not avg-of-avgs)', () => {
    const central = reduceRecords(shards.flat(), spec)
    expect(partialEndToEnd(shards)).toEqual(central)
    expect(partialEndToEnd(shards).mean).toBe(230) // 1380/6, NOT (133.3+70+455)/3
  })

  it('empty partial set finalizes to the empty-aggregate result', () => {
    expect(finalizePartial(spec, mergePartials(spec, []))).toEqual(reduceRecords([], spec))
  })
})
