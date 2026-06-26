# Insight Vault — zero-knowledge profile

Issue #10. Technical reference for `@klum-db/lobby`'s cross-vault derivation layer: how the Insight Vault is weaker than per-vault guarantees, where the load-bearing invariant sits, and the operational knobs that interact with it.

Related: [architecture.md](./architecture.md) · [glossary/schema-migration.md](./glossary/schema-migration.md) · federation (#9)

---

## Per-vault ZK baseline

Each `@noy-db` vault's backend store sees only ciphertext. Records are encrypted under that vault's DEK (data-encryption key); the store is crypto-blind to record content. That is noy-db's guarantee and the baseline this Lobby inherits.

---

## The Insight Vault is opt-in and weaker

The Insight Vault is registered via `group.withCrossVaultDerivation(spec)` and targets a **separate** analytics vault (`spec.target.vault`) that must not be the group itself or any of its shards (enforced at registration — `vault-group.ts:325-329`).

```ts
// types.ts:215 — CrossVaultDerivationSpec
interface CrossVaultDerivationSpec<R, S> {
  source: string                                           // collection read from each shard
  target: { vault: string; collection: string }           // the Insight Vault
  derive: (records: R[], ctx: CrossVaultDerivationContext) => S  // per-shard reducer
  autoPush?: boolean | InsightAutoPushConfig
}
```

Its position in the trust model:

| Property | Shard vault | Insight Vault |
|---|---|---|
| Data model | raw application records (per-subject) | aggregate summary rows (per-shard, one per source shard) |
| Backend visibility | ciphertext only | aggregate scalars (totals, counts, timestamps) + cross-shard structure |
| DEK | vault's own DEK | Insight Vault's **own separate DEK** |
| Trust tier (conceptual, not an API field) | source-of-truth | derived |
| Embeddings | per vault's own policy | explicitly excluded to hold this profile |
| Opt-in | n/a | **yes** — explicit `withCrossVaultDerivation` call |

---

## The DEK-boundary invariant — the load-bearing guarantee

**Source ciphertext never crosses a DEK boundary.** Only the caller-supplied derived aggregate does, re-encrypted under the Insight Vault's own DEK.

The mechanism in full:

1. `refreshInsights()` calls `db.queryAcross` over each eligible shard — opening each shard vault inside the in-process `Noydb` (which holds both the shard's and the Insight Vault's keyrings). (`vault-group.ts:376-383`)
2. Per shard: `vault.collection(spec.source).list()` returns the decrypted records **in-process only**. (`vault-group.ts:379-380`)
3. `spec.derive(records, ctx)` runs in-process on those decrypted records, returning a scalar summary `S`. (`vault-group.ts:399`)
4. The summary is written to the Insight Vault via `out.put(row.partitionKey, summary)` — stored under the Insight Vault's own DEK. (`vault-group.ts:400`)

The auto-push path (`_recomputeShardInsights`) follows the same sequence: open the triggering shard → `.list()` → `derive` → `put` to the Insight Vault. (`vault-group.ts:417-435`)

At no step do raw records or their ciphertext move to the Insight Vault's store. The `derive` callback reduces N records to one scalar row; only that scalar row is encrypted and written.

The registration guard enforces isolation in the other direction — `target.vault` must be outside the group's shard namespace (`vault-group.ts:325-329`). A summary writing back into a client-shard would breach the per-shard DEK boundary; the check throws a `ValidationError` before any derivation is registered.

---

## Trust and executor model

The derivation executor is the in-process holder of the group's single `Noydb` instance. That instance holds **both** the shards' keyrings and the Insight Vault's keyring — the "admin-instance" model.

**Blast radius:** full read access to all shards in the group + write access to the Insight Vault. Any code sharing the same `Noydb` handle can call `refreshInsights()` or register a derivation.

A least-privilege model — where the derivation executor holds only a per-shard operator grant covering the source collection — was considered and is a **non-goal** at this stage. It would require a noy-db cross-vault capability grant (a new keyring primitive) that does not exist. The current model is consistent with the admin-instance assumption already present in `VaultGroup` fan-out reads.

State this plainly in any threat model: **treat the Insight Vault's backend as a trust surface whose compromise reveals aggregate cross-shard structure** (per-shard totals, counts, timestamps) but not raw records or per-record ciphertext.

---

## What the Insight backend learns vs. does not learn

The `derive` callback is caller-supplied; the Insight Vault's exposure is exactly what that callback returns. The Lobby makes no structural guarantee about its content beyond what the registration contract states.

| The Insight backend learns | The Insight backend does NOT learn |
|---|---|
| Per-shard aggregate scalars — whatever `derive` returns (e.g. counts, sums, timestamps) | Raw application records |
| Cross-shard structure: one row per shard, keyed by partition key, with `vaultId` and `partitionKey` in `CrossVaultDerivationContext` | Per-record ciphertext from any shard |
| The partition key of each contributing shard | The DEK of any shard |
| Relative shard sizes / active shard count (implied by the row set) | Record-level payloads (field values, identifiers) |

**To hold this profile:** keep `derive` return values to aggregate scalars. Do not include raw records, raw field values, embeddings, or any structure that leaks individual record content. There is no enforcement — the callback is caller-supplied — so this is a design constraint on each registration, not a library-enforced invariant.

---

## Operational knobs that interact with the ZK profile

### `minVersion` gating

Both `refreshInsights()` (explicit) and auto-push (`_recomputeShardInsights`) gate on `schemaVersion`. A shard whose registry row's `schemaVersion` is below `InsightAutoPushConfig.minVersion` is skipped — its prior summary is left intact, not deleted. (`vault-group.ts:429`)

```ts
// types.ts:195 — InsightAutoPushConfig
interface InsightAutoPushConfig {
  debounceMs?: number   // reset-debounce window for write bursts
  minVersion?: number   // skip a shard whose schemaVersion is below this
}
```

Effect on the ZK profile: a behind-version shard's stale summary remains in the Insight Vault until the shard is migrated and a reconciling `refreshInsights({ only: [pk] })` or `refreshDerivation(pk)` runs. The Insight Vault may present an inconsistent cross-shard aggregate until then — this is expected and documented behavior (#13).

### Auto-push debounce (`autoPush.debounceMs`)

When `debounceMs` is set, the `InsightAutoPush` controller batches write notifications on a reset-debounce timer before flushing. (`insight-auto-push.ts:52-75`) The shard's summary is not updated until the debounce window closes; intermediate write states are not observable in the Insight Vault. This is a pure scheduling knob — it does not change what the backend sees, only when.

A failed per-shard recompute is reported via `onError` and never breaks the flush loop. The Insight Vault retains the last successfully computed summary for that shard until a reconciling call succeeds. (`insight-auto-push.ts:83-87`)

### Shard eligibility and `skippedVaults`

`refreshInsights` reports shards excluded from a pass in `skippedVaults` — reason `'schema-drift'` (below `minVersion`) or `'error'` (unreachable backend / read failure). An excluded shard's prior summary is never deleted. Use `refreshDerivation(partitionKey)` or `refreshInsights({ only: [pk] })` to reconcile a previously-skipped shard after its backend recovers. (`vault-group.ts:367-405`)

---

## When to opt in

The Insight Vault is appropriate when:

- The group caller is already authorized across all member vaults (the `Noydb` admin-instance assumption is already met).
- The cross-shard aggregate view is genuinely necessary (a fleet-wide rollup, shard health summary, or cross-shard count), and querying it repeatedly via `queryAcross` fan-out is operationally unsuitable.
- The `derive` function can be scoped to aggregate scalars — no raw record payloads, no embeddings.

The Insight Vault is **not** appropriate when:

- The analytics backend has a different trust boundary from the admin instance (different operator, different custody boundary, different data classification). In that case the Insight Vault's separate DEK alone does not isolate it — the admin instance still holds that DEK.
- The required summaries would need raw record fields or per-record identifiers — that would collapse the ZK profile to the same level as direct cross-shard fan-out reads.
- The group has shards across data-residency regions and the Insight Vault's backend is in a different region — the aggregate may carry residency-sensitive signals (e.g. per-region counts implying subject presence).

In all these cases, use explicit `queryAcross` fan-out (`ShardedCollection.query().toArray()` / `.aggregate()`) rather than the push-model Insight Vault, and evaluate the backend exposure of that fan-out result separately.

---

## Summary of guarantees and non-guarantees

| Claim | Status |
|---|---|
| Source shard ciphertext never written to the Insight Vault's store | **Guaranteed** — by construction (derive runs in-process; only the scalar return is written) |
| Per-record payloads not exposed to the Insight backend | **Depends on `derive`** — caller must keep summaries to aggregate scalars |
| Insight Vault uses its own DEK, independent of shard DEKs | **Guaranteed** — backed by noy-db's per-vault DEK model |
| Insight backend cannot derive individual records from the summary | **Depends on `derive`** — aggregate scalars hold this; embeddings or field-level values do not |
| `target.vault` cannot be a shard in the group | **Enforced** — `ValidationError` thrown at `withCrossVaultDerivation` registration (`vault-group.ts:325`) |
| Stale summaries from schema-drifted shards are auto-deleted | **Not guaranteed** — stale rows persist until a reconciling pass |
| The admin instance cannot read all shard records | **Not guaranteed** — the `Noydb` holder has full fleet read access; the Insight Vault feature does not narrow this |
