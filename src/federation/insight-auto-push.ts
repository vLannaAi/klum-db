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
  private readonly dirty = new Set<string>()
  private pending: Promise<void> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private resolvePending: (() => void) | null = null

  constructor(
    private readonly recompute: (partitionKey: string) => Promise<void>,
    private readonly isSource: (collection: string) => boolean,
    private readonly onError: (err: unknown, partitionKey: string) => void = (err, pk) =>
      console.warn(`[klum-db] insight auto-push failed for shard "${pk}":`, err),
    /** When set, batch writes on a reset-debounce timer instead of per microtask (#13). */
    private readonly debounceMs?: number,
  ) {}

  /** Called from a shard's onAfterWrite hook. Marks the shard dirty + schedules a flush. */
  noteWrite(partitionKey: string, collection: string): void {
    if (!this.isSource(collection)) return
    this.dirty.add(partitionKey)
    if (this.debounceMs !== undefined) this.scheduleDebounced()
    else this.schedule()
  }

  /** Resolve once no flush is pending (drains rescheduled flushes too). */
  async whenSettled(): Promise<void> {
    while (this.pending) await this.pending
  }

  // ── microtask path (unchanged default) ──
  private schedule(): void {
    if (this.pending) return
    this.pending = this.runFlush().finally(() => {
      this.pending = null
      // Writes that arrived during the flush re-dirty the set — drain them.
      if (this.dirty.size > 0) this.schedule()
    })
  }

  // ── debounce path (#13) ──
  private scheduleDebounced(): void {
    if (!this.pending) this.pending = new Promise<void>((r) => { this.resolvePending = r })
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.runFlush().finally(() => {
        if (this.dirty.size > 0) {
          this.scheduleDebounced() // re-dirtied during flush — restart the window
        } else {
          const resolve = this.resolvePending
          this.resolvePending = null
          this.pending = null
          resolve?.()
        }
      })
    }, this.debounceMs)
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
