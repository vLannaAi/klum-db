/**
 * @category capability
 * Cross-vault federated retrieval (#26). Scatter each shard's own trusted-tier
 * `retrieve()`, then RRF-fuse the per-vault ranked lists by rank only (no
 * cross-vault statistics cross the boundary). Mirrors aggregate-across.ts.
 */
import { fuseRetrieval } from '@noy-db/hub/kernel'
import type { RetrieveHit, Query } from '@noy-db/hub/kernel'
import type { VaultGroup } from './vault-group.js'
import { classifyShardSkip } from './classify-skip.js'
import type { FederatedRetrieveOptions, FederatedRetrieveHit, FederatedRetrieveResult, SkippedVault } from './types.js'

/** NUL cannot occur in a vault id or record id — safe composite-id separator. */
const SEP = '\0'

export async function retrieveAcross<T, R>(
  group: VaultGroup<T>,
  collectionName: string,
  query: string,
  opts: FederatedRetrieveOptions = {},
): Promise<FederatedRetrieveResult<R>> {
  const { eligible, skipped } = await group.resolveEligible({
    ...(opts.minVersion !== undefined ? { minVersion: opts.minVersion } : {}),
    ...(opts.failFast !== undefined ? { failFast: opts.failFast } : {}),
  })

  const across = await group.db.queryAcross<RetrieveHit<R>[]>(
    eligible.map((r) => r.vaultId),
    async (vault) => {
      group.template.configure(vault)
      const coll = vault.collection<R>(collectionName)
      let within: Query<R> | undefined
      if (opts.where?.length) {
        let q = coll.query()
        for (const [f, op, v] of opts.where) q = q.where(f, op, v)
        within = q
      }
      return coll.retrieve(query, {
        ...(opts.mode ? { mode: opts.mode } : {}),
        ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
        ...(opts.minScore !== undefined ? { minScore: opts.minScore } : {}),
        ...(opts.fields ? { fields: opts.fields } : {}),
        ...(opts.match ? { match: opts.match } : {}),
        ...(opts.prefix ? { prefix: opts.prefix } : {}),
        ...(opts.snippetWindow !== undefined ? { snippetWindow: opts.snippetWindow } : {}),
        ...(opts.includeRecord ? { includeRecord: true } : {}),
        ...(within ? { within } : {}),
      })
    },
    { concurrency: opts.concurrency ?? 1, create: false },
  )

  const skippedVaults: SkippedVault[] = [...skipped]
  const perVault: Array<{ vault: string; hits: RetrieveHit<R>[] }> = []
  for (const r of across) {
    if (r.error) {
      if (opts.failFast) throw r.error
      skippedVaults.push({ vaultId: r.vault, reason: classifyShardSkip(r.error), error: r.error })
    } else {
      perVault.push({ vault: r.vault, hits: r.result })
    }
  }

  // Qualify ids so the same local id in two shards stays distinct under fusion.
  const lists = perVault.map((pv) => {
    if (pv.vault.includes(SEP)) {
      throw new Error(`retrieveAcross: vault id "${pv.vault}" contains the reserved NUL separator`)
    }
    return pv.hits.map((h) => ({ ...h, id: pv.vault + SEP + h.id }))
  })
  const fused = fuseRetrieval(lists, {
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    ...(opts.rrfK !== undefined ? { k: opts.rrfK } : {}),
  })
  const hits: FederatedRetrieveHit<R>[] = fused.map((h) => {
    const i = h.id.indexOf(SEP)
    return { ...h, vault: h.id.slice(0, i), id: h.id.slice(i + 1) }
  })
  return { hits, skippedVaults }
}
