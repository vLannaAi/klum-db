/**
 * @klum-db/lobby interchange — shared staging helper.
 *
 * Transforms each incoming record, re-injects the canonical `id`, and
 * pre-validates every record against the receiver schema BEFORE any write.
 * A throwing transform or a failing validation bubbles out here, leaving the
 * receiver untouched (staging-safety). Used by both `migrateThenMerge` (FR-8,
 * version-windowed steps) and `graduate()` (foreign→target mapping).
 *
 * @module
 */
import type { Vault } from '@noy-db/hub'
import type { DecryptedRecord } from '@noy-db/hub/bundle'

/** A pure record-body transform: old body → new body. */
export type RecordTransform = (body: Record<string, unknown>) => Record<string, unknown>

/**
 * Thrown BEFORE any write when a collection's records do not validate against
 * the receiver schema and no transform was supplied to fix the shape.
 */
export class MigrationTransformRequiredError extends Error {
  constructor(
    public readonly collection: string,
    public readonly cause?: unknown,
  ) {
    super(
      `collection "${collection}" did not validate against the receiver schema after ` +
        `transformation and no transform was supplied to reach the target shape. Provide a ` +
        `transform for "${collection}". Underlying: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
    this.name = 'MigrationTransformRequiredError'
  }
}

/**
 * Stage incoming records: apply per-collection transforms (in array order),
 * re-inject the canonical `id`, and validate every staged record against the
 * receiver schema. Returns the staged records; never writes.
 */
export async function stageAndValidate(
  receiver: Vault,
  incoming: Record<string, readonly DecryptedRecord[]>,
  transformsByCollection: Record<string, readonly RecordTransform[]>,
): Promise<Record<string, DecryptedRecord[]>> {
  const staged: Record<string, DecryptedRecord[]> = {}
  for (const [coll, recs] of Object.entries(incoming)) {
    const transforms = transformsByCollection[coll] ?? []
    const out: DecryptedRecord[] = []
    for (const r of recs) {
      let body = r.record
      for (const t of transforms) body = t(body)
      // Re-inject the canonical id: a transform that drops/renames `id` must not
      // silently detach the row from its identity.
      out.push({ ...r, record: { ...body, id: r.id } })
    }
    staged[coll] = out

    const rc = receiver.collection(coll)
    for (const r of out) {
      try {
        await rc.validateInput(r.record)
      } catch (cause) {
        throw new MigrationTransformRequiredError(coll, cause)
      }
    }
  }
  return staged
}
