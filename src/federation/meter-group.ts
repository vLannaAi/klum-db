import type { VaultGroup } from './vault-group.js'
import type { SkippedVault } from './types.js'

export interface GroupShardMetrics {
  readonly vaultId: string
  readonly partitionKey: string
  readonly schemaVersion: number
  readonly collections: number
  readonly records: number
}

export interface GroupMeterReport {
  /** Number of eligible shards measured. */
  readonly vaults: number
  /** Distinct collection names across the group. */
  readonly collections: number
  /** Total record count summed across shards. */
  readonly records: number
  readonly perShard: ReadonlyArray<GroupShardMetrics>
  /** Drifted / provisioning-failed shards — surfaced, never counted or hidden. */
  readonly skipped: ReadonlyArray<SkippedVault>
}

/**
 * Fan shape-metrics (collection count + record count) across the group's
 * ELIGIBLE shards. Skipped shards (schema-drift / provisioning failures) are
 * reported in `skipped`, never silently dropped. Reuses the per-vault pattern
 * from `multi-bundle.ts` (`vault.collections()` → `collection(n).count()`).
 *
 * Operational store metrics (calls, CAS conflicts) are a separate concern and
 * are already group-wide via `@noy-db/to-meter` on the underlying store.
 */
export async function meterGroup<T>(
  group: VaultGroup<T>,
  opts: { minVersion?: number } = {},
): Promise<GroupMeterReport> {
  const { eligible, skipped } = await group.resolveEligible(
    opts.minVersion !== undefined ? { minVersion: opts.minVersion } : {},
  )
  const perShard: GroupShardMetrics[] = []
  const names = new Set<string>()
  let records = 0
  for (const row of eligible) {
    const vault = await group.shard(row.partitionKey)
    const collNames = await vault.collections()
    let shardRecords = 0
    for (const n of collNames) {
      names.add(n)
      shardRecords += await vault.collection(n).count()
    }
    records += shardRecords
    perShard.push({
      vaultId: row.vaultId,
      partitionKey: row.partitionKey,
      schemaVersion: row.schemaVersion,
      collections: collNames.length,
      records: shardRecords,
    })
  }
  return { vaults: eligible.length, collections: names.size, records, perShard, skipped }
}
