# Migrating a federated noy-db pilot onto `@klum-db/lobby`

**Audience:** maintainers of a federated noy-db deployment (a "pilot") that uses vault groups / sharding / cross-vault features, upgrading to the separated `@klum-db/lobby`.

**TL;DR:** Federation, the multivault bundle, and all cross-vault orchestration moved **out of `@noy-db/hub`** and **into `@klum-db/lobby`**. Your single-vault world (data, crypto, schema cutover) is unchanged and stays in `@noy-db/hub`. So: install `@klum-db/lobby`, wrap your `Noydb` with `createLobby(db)`, move federation calls onto the `lobby`, and apply a handful of renames. **No on-disk data format change** — this is a code-layer move; rollback is safe.

---

## Part 1 — Compatibility audit (what changed)

### A. Federation moved: `@noy-db/hub` → `@klum-db/lobby`

`@noy-db/hub` no longer ships the fleet methods (not even the old `FederationMovedError` shim). Get them from a `Lobby`:

```ts
// BEFORE — in-hub federation
const group = await db.openVaultGroup('firm-clients', { registry, sharding })
db.withVaultTemplate('client-template', { version: 1, configure })
const sv = await db.openStateManagementVault()

// AFTER — @klum-db/lobby
import { createLobby } from '@klum-db/lobby'
const lobby = createLobby(db)
lobby.withVaultTemplate('client-template', { version: 1, configure })   // register templates on the lobby first
const group = await lobby.openVaultGroup('firm-clients', { registry, sharding })
const sv = await lobby.openStateManagementVault()
```

| Removed from `@noy-db/hub` | Now in `@klum-db/lobby` |
|---|---|
| `Noydb.openVaultGroup(...)` | `lobby.openVaultGroup(...)` |
| `Noydb.withVaultTemplate(...)` | `lobby.withVaultTemplate(...)` |
| `Noydb.openStateManagementVault()` | `lobby.openStateManagementVault()` |
| `VaultGroup`, `ShardedCollection`, `ShardedQuery`, `CrossVaultAggregation`, `StateManagementVault` (types) | exported from `@klum-db/lobby` |
| `crossShardJoin` query op | method on the klum sharded query (`group.collection(n).query().crossShardJoin(...)`) |
| `CrossShardJoinError`, `UnknownShardError`, `ShardProvisioningError`, `VaultTemplateNotFoundError`, `ReservedVaultNameError`, `DataResidencyError` | re-exported from `@klum-db/lobby` (also still on `@noy-db/hub/kernel`) |

### B. Multivault bundle moved: `@noy-db/hub` → `@klum-db/lobby`

```ts
// BEFORE: import { encodeMultiBundle, writeMultiVaultBundle, readNoydbBundleManifest,
//                  readMultiVaultBundleCompartment } from '@noy-db/hub'   // or '@noy-db/hub/bundle'
// AFTER:  import { encodeMultiBundle, writeMultiVaultBundle, readNoydbBundleManifest,
//                  readMultiVaultBundleCompartment } from '@klum-db/lobby'
```

The **single-vault** `.noydb` bundle (`writeNoydbBundle` / `readNoydbBundle` / `readNoydbBundleHeader`) **stays** in `@noy-db/hub/bundle` — only the multi-compartment (NDBM) bundle moved.

### C. Renames — the Rollout / Cutover vocabulary (`@klum-db/lobby` ≥ `0.2.0-pre.29`)

| Old | New |
|---|---|
| `group.migrateFleet(...)` | `group.rolloutSchema(...)` |
| `group.migrateShard(pk)` | `group.cutoverShard(pk)` |
| `VaultGroupOptions.migrateOnOpen` | `cutoverOnOpen` |
| `FleetMigrationResult` (type) | `SchemaRolloutResult` |

These are pure API renames (no persisted-data change). See `docs/glossary/schema-migration.md` for the **Transform → Cutover → Rollout** model.

### D. What did NOT change (stays in `@noy-db/hub`)

Your single-vault world is untouched:
- `createNoydb`, `db.openVault`, collections, queries, indexes, materialized views.
- Crypto / keyring / sealing.
- **Single-vault schema cutover** — `vault.runSchemaCutover()`, `TransformFn`, the fence subsystem. (A `Rollout` simply orchestrates these per shard.)
- The single-vault `.noydb` bundle, `extractPartition`, withdrawal.
- **Custody** (`createDeedOwner`, `liberateVault`, `CustodyApi`) — implemented in hub, **also re-exported by `@klum-db/lobby`** so you can import it from one place.

### E. Versions & peer dependencies (read this)

`@klum-db/lobby@0.2.0-pre.29` peer-requires `@noy-db/*` at `^0.2.0-pre.26`, and the noy-db packages peer-require **each other at the exact published version** under strict peers. So **pin every `@noy-db/*` package to the same version** (≥ `0.2.0-pre.26`) and add `@klum-db/lobby`:

```jsonc
{
  "dependencies": {
    "@noy-db/hub": "0.2.0-pre.26",
    "@klum-db/lobby": "0.2.0-pre.29"
    // + every other @noy-db/* you use (adapters, as-xlsx, …) ALL at 0.2.0-pre.26
  }
}
```

`@klum-db/lobby` ships on the `next` dist-tag (`npm i @klum-db/lobby@next`). If install fails with an unmet-peer error, it's almost always a stray `@noy-db/*` left at an older version — align them all.

### F. New capabilities you get

- **Federation tooling:** `groupInspector(group)` (drive `@noy-db/in-devtools` over a whole fleet), `meterGroup(group)` (group-wide record/collection metrics), and a `klum` CLI (`inspect-group`, `meter-group`).
- **Surface / scoped sync**, **dock → graduate**, **cross-vault extract / merge / migrate-then-merge** — all in `@klum-db/lobby`.

---

## Part 2 — Migration steps

1. **Pin versions** (§E). Install; resolve strict-peer errors by aligning every `@noy-db/*` to one `pre.N` (≥ `pre.26`).
2. **Create the Lobby once**, next to where you create your `Noydb`: `const lobby = createLobby(db)`.
3. **Move federation calls** off `db` onto `lobby` (§A). Register templates on the lobby *before* opening groups.
4. **Repoint multivault-bundle imports** to `@klum-db/lobby` (§B).
5. **Apply the renames** (§C).
6. **Build + typecheck.** The remaining `@noy-db/hub` import errors are your migration checklist — each maps to a row in §A/§B.
7. **Run your tests** against the published packages.

---

## Part 3 — Cutover checklist

- [ ] Every `@noy-db/*` at one version (≥ `pre.26`); `@klum-db/lobby@next` (≥ `pre.29`) added.
- [ ] `grep -rE "openVaultGroup|withVaultTemplate|openStateManagementVault|encodeMultiBundle|MultiVaultBundle" src/` returns **no** imports from `@noy-db/hub`.
- [ ] `createLobby(db)` created once; templates registered on it.
- [ ] Renames applied (`rolloutSchema` / `cutoverShard` / `cutoverOnOpen` / `SchemaRolloutResult`).
- [ ] typecheck + build + tests green.
- [ ] Staging smoke: open a group, route a write to a shard, run a `rolloutSchema` (or `cutoverShard`) dry-run, inspect with `klum inspect-group`.
- [ ] **Rollback plan:** pin back to the prior `@noy-db` version and drop `@klum-db/lobby`. Safe — federation is a code-layer move; your vault data, registry rows, and state vault are byte-unchanged.

---

## Part 4 — Want a pilot-specific diff?

Share the pilot's `package.json` and its federation surface —

```bash
grep -rnE "openVaultGroup|VaultGroup|withVaultTemplate|StateManagement|migrateFleet|migrateShard|MultiBundle|crossShardJoin" src/
```

— and I'll produce the exact before/after edits and the precise version-pin set for that codebase.
