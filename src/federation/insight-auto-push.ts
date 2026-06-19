/**
 * @klum-db/lobby federation — Insight auto-push controller (#12).
 *
 * Pure scheduling: coalesces shard writes into one microtask flush per burst.
 * Knows nothing about vaults — it calls back into the owner via `recompute`
 * (re-derive + push that shard's summary) and `isSource` (does this collection
 * feed an auto-push derivation?). Best-effort: a failed recompute is reported
 * via `onError` and never breaks the loop or the awaiting caller.
 *
 * @module
 */
export class InsightAutoPush {
  /** Partition keys awaiting recompute. */
  private readonly dirty = new Set<string>()
  /** The in-flight flush, or null when idle. */
  private pending: Promise<void> | null = null

  constructor(
    private readonly recompute: (partitionKey: string) => Promise<void>,
    private readonly isSource: (collection: string) => boolean,
    private readonly onError: (err: unknown, partitionKey: string) => void = (err, pk) =>
      console.warn(`[klum-db] insight auto-push failed for shard "${pk}":`, err),
  ) {}

  /** Called from a shard's onAfterWrite hook. Marks the shard dirty + schedules a flush. */
  noteWrite(partitionKey: string, collection: string): void {
    if (!this.isSource(collection)) return
    this.dirty.add(partitionKey)
    this.schedule()
  }

  /** Resolve once no flush is pending (drains rescheduled flushes too). */
  async whenSettled(): Promise<void> {
    while (this.pending) await this.pending
  }

  private schedule(): void {
    if (this.pending) return
    this.pending = this.runFlush().finally(() => {
      this.pending = null
      // Writes that arrived during the flush re-dirty the set — drain them.
      if (this.dirty.size > 0) this.schedule()
    })
  }

  private async runFlush(): Promise<void> {
    // Let same-tick writes coalesce into this flush before snapshotting.
    await Promise.resolve()
    const pks = [...this.dirty]
    this.dirty.clear()
    for (const pk of pks) {
      try {
        await this.recompute(pk)
      } catch (err) {
        this.onError(err, pk)
      }
    }
  }
}
