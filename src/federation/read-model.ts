/**
 * Federated read-model over a VaultGroup — S1: engine + rollup shape
 * (#44/#55; spec: docs/federated-read-model.md).
 *
 * A maintained, queryable read-model vault composing per-shard
 * collections across the group. Consumers enrich WITHIN each shard
 * using hub machinery (e.g. an #810 projection MV registered via
 * `materializedViewStrategies`); the read-model owns the CROSS-shard
 * half. S1 ships the rollup shape (per-shard reduce → one summary row
 * per shard); the mirror shape is S2 (#56).
 *
 * ZK boundary: only fields declared in the model's `posture.surface`
 * cross into the read-model vault — an undeclared emitted field FAILS
 * CLOSED with {@link PostureViolationError} (rejected, not silently
 * stripped), so a leaking `derive` is caught in development. Rows are
 * re-encrypted under the read-model vault's key by the ordinary put
 * pipeline; shard ciphertext never crosses.
 */
import { ValidationError } from '@noy-db/hub/cargo'
import type { Collection, Vault } from '@noy-db/hub'
import type { VaultGroup } from './vault-group.js'
import type { CrossVaultDerivationContext, SkippedVault } from './types.js'

/** Explicit ZK surface: the only fields a model may emit. */
export interface ReadModelPosture {
  readonly surface: readonly string[]
}

/** Rollup model: per-shard reduce → one summary row per shard. */
export interface RollupModelSpec<R = Record<string, unknown>, S extends Record<string, unknown> = Record<string, unknown>> {
  /** Output collection name in the read-model vault. */
  readonly name: string
  readonly kind: 'rollup'
  /** Collection read from each shard (plain or MV-output — the engine is agnostic). */
  readonly source: string
  /** Per-shard reducer. Must be pure — no clock, no randomness. */
  readonly derive: (records: R[], ctx: CrossVaultDerivationContext) => S
  readonly posture: ReadModelPosture
}

/** S1: rollup only. S2 (#56) adds the mirror shape to this union. `never` makes caller-typed `derive` params assignable (contravariance). */
export type ReadModelSpec = RollupModelSpec<never>

/** Options for `Lobby.openReadModel`. */
export interface OpenReadModelOptions {
  /** The read-model vault. Must not be the group or one of its shards. */
  readonly vault: string
  readonly models: readonly ReadModelSpec[]
}

/** The result of {@link ReadModel.refresh}. */
export interface ReadModelRefreshResult {
  readonly written: number
  readonly skippedVaults: SkippedVault[]
}

/** Fail-closed posture breach: a model emitted a field outside its declared surface. */
export class PostureViolationError extends Error {
  override readonly name = 'PostureViolationError'
  constructor(
    readonly model: string,
    readonly fields: readonly string[],
    readonly shard: string,
  ) {
    super(
      `read-model "${model}": derive emitted undeclared field(s) [${fields.join(', ')}] for shard "${shard}" — ` +
      `every emitted field must be listed in posture.surface (fail closed; nothing was written).`,
    )
  }
}

/** Engine-owned provenance fields stamped on every read-model row. */
const PROVENANCE_FIELDS = new Set(['_shard', '_sourceVersion'])

function checkPosture(model: ReadModelSpec, row: Record<string, unknown>, shard: string): void {
  const declared = new Set(model.posture.surface)
  const undeclared = Object.keys(row).filter((k) => !declared.has(k) && !PROVENANCE_FIELDS.has(k))
  if (undeclared.length > 0) throw new PostureViolationError(model.name, undeclared, shard)
}

/**
 * A maintained federated read-model. Read side is deliberately boring:
 * {@link collection} returns ordinary collections in the read-model
 * vault — one query, never N shard opens.
 */
export class ReadModel<T> {
  /** @internal */
  constructor(
    private readonly group: VaultGroup<T>,
    private readonly vaultName: string,
    private readonly vault: Vault,
    private readonly models: readonly ReadModelSpec[],
  ) {}

  /** An output collection of the read-model vault (keyed by model `name`). */
  collection<S extends Record<string, unknown> = Record<string, unknown>>(model: string): Collection<S> {
    return this.vault.collection<S>(model)
  }

  /**
   * Explicit refresh: for each model, read every eligible shard's
   * `source`, reduce, posture-check, and write one summary row per
   * shard — deterministic id = partitionKey, stamped with `_shard` +
   * `_sourceVersion` (the shard's schema version at derive time).
   * Unreachable shards land in `skippedVaults` (never silently dropped).
   */
  async refresh(options: { minVersion?: number; concurrency?: number; only?: readonly string[]; failFast?: boolean } = {}): Promise<ReadModelRefreshResult> {
    const { eligible, skipped } = await this.group.resolveEligible({
      ...(options.minVersion !== undefined ? { minVersion: options.minVersion } : {}),
      ...(options.only !== undefined ? { only: options.only } : {}),
      ...(options.failFast !== undefined ? { failFast: options.failFast } : {}),
    })
    let written = 0
    for (const model of this.models) {
      const results = await this.group.db.queryAcross<Record<string, unknown>[]>(
        eligible.map((r) => r.vaultId),
        async (vault) => {
          this.group.template.configure(vault)
          return vault.collection<Record<string, unknown>>(model.source).list()
        },
        { create: false, ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}) },
      )
      const out = this.vault.collection<Record<string, unknown>>(model.name)
      for (let i = 0; i < eligible.length; i++) {
        const row = eligible[i]!
        const res = results[i]
        if (!res || res.result === undefined) {
          if (options.failFast && res?.error) throw res.error
          if (!skipped.some((s) => s.vaultId === row.vaultId)) {
            skipped.push({ vaultId: row.vaultId, reason: 'error', ...(res?.error ? { error: res.error } : {}) })
          }
          continue
        }
        const ctx: CrossVaultDerivationContext = {
          vaultId: row.vaultId,
          partitionKey: row.partitionKey,
          schemaVersion: row.schemaVersion,
        }
        const summary = (model.derive as (r: Record<string, unknown>[], c: CrossVaultDerivationContext) => Record<string, unknown>)(res.result, ctx)
        checkPosture(model, summary, row.partitionKey)
        await out.put(row.partitionKey, {
          ...summary,
          _shard: row.partitionKey,
          _sourceVersion: row.schemaVersion,
        })
        written++
      }
    }
    return { written, skippedVaults: skipped }
  }
}

/** Open a read-model over `group`. See `Lobby.openReadModel`. */
export async function openReadModel<T>(
  group: VaultGroup<T>,
  opts: OpenReadModelOptions,
): Promise<ReadModel<T>> {
  const target = opts.vault
  if (target === group.name || target.startsWith(`${group.name}--`)) {
    throw new ValidationError(
      `openReadModel: vault "${target}" is the "${group.name}" group itself or one of its shards — ` +
      `the read-model must live outside the group it composes.`,
    )
  }
  if (opts.models.length === 0) {
    throw new ValidationError('openReadModel: at least one model is required.')
  }
  const seen = new Set<string>()
  for (const m of opts.models) {
    if (seen.has(m.name)) throw new ValidationError(`openReadModel: duplicate model name "${m.name}".`)
    seen.add(m.name)
    if (m.posture.surface.length === 0) {
      throw new ValidationError(`openReadModel: model "${m.name}" declares an empty posture.surface.`)
    }
  }
  const vault = await group.db.openVault(target)
  return new ReadModel(group, target, vault, opts.models)
}
