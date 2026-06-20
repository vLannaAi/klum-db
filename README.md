# @klum-db/lobby

> **`@klum-db/lobby` is the control plane for a fleet of sovereign [noy-db](https://github.com/vLannaAi/noy-db) vaults.** It coordinates many vaults — federate, move data, custody, sync — but **never owns the data**: each vault is a complete, sovereign system on its own. The dependency is **one-way** — klum drives noy; **noy never knows klum exists.**

`@klum-db/lobby` · status: **preview** · depends on `@noy-db/hub`

---

## What it is, in 20 seconds

noy-db gives you **one** self-contained, encrypted vault — a complete system on its own. The Lobby is what you add when one actor must work across **many** vaults at once.

```
  ┌────────────────────────────────────────────────────┐
  │  CONTROL PLANE · @klum-db/lobby                      │
  │  federate · interchange · custody · surface         │
  └────────────────────────┬───────────────────────────┘
                           │ drives — one-way (klum → noy)
        ┌──────────┬───────┴───────┬──────────┐
        ▼          ▼               ▼          ▼
     ┌──────┐   ┌──────┐        ┌──────┐   ┌──────┐
     │vault │   │vault │        │vault │   │vault │
     └──────┘   └──────┘        └──────┘   └──────┘
  DATA PLANE · @noy-db/hub — each vault sovereign & non-fungible,
  complete on its own.  noy never depends on klum.
```

- **Control plane (klum)** coordinates the fleet — but, like any control plane, it *never owns the data plane's data*. Custody, crypto, and records stay sovereign in each vault.
- **Data plane (noy)** is N independent vaults. noy looks **inward** at one vault; klum looks **outward** across many — the same boundary, named for developers.
- **One seam, one direction.** klum binds only to the stable `@noy-db/hub/kernel` contract — never hub internals. No `@noy-db` package ever imports `@klum-db` (enforced by a build-time guard). A vault is a complete, shippable system *without* the Lobby.
- **A group, not a cluster.** The vaults are sovereign and non-fungible — one subject = one vault, and the subject holds the deed. (Thai *klum* กลุ่ม = a group.)

## Why it exists

Banking, accounting, health, insurance — the data that matters is **individual, single-entity, and owned by the subject**. noy-db makes each of those a small, sovereign, in-memory vault that is a *complete system on its own*. Working "small, in memory" isn't a limitation — it's the strong core. The limitation only bites when one actor must work across **many** datasets at once.

The **Lobby** is the framework for exactly that outward dimension: *the efficiency of a small independent dataset at the core, joined with an actor operating across many at the same time* — a counterbalance to tech giants holding user data hostage. Vaults stay independent and relocatable; the Lobby coordinates them without absorbing them.

## Reads in a sentence

> A firm is a **Custodian** in the **Lobby**: it holds operating grants to client **Vaults** that all reference one shared **Pool**. The client holds the **Deed**. To onboard, the firm **Relocates** a client's vault as a **Bundle**, **Migrates** it to the current schema, and **Merges** the Pool slice by field **Authority** using **Provenance**. The client can **Withdraw** anytime; an abandoned vault can be **Liberated**.

Every bold word is a real, shipped capability.

## Install

```bash
pnpm add @klum-db/lobby @noy-db/hub
```

```ts
import { createNoydb } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'
import { createLobby } from '@klum-db/lobby'

const db = await createNoydb({ store: memory(), user: 'firm', secret: '…' })
const lobby = createLobby(db)
```

---

## The four pillars

### 1 · Federation — operate many vaults as a fleet

A `VaultGroup` shards one logical dataset across per-entity vaults (one client = one vault), with cross-shard queries, firm-wide **Insight** rollups (zero client data crosses a DEK boundary), and a resumable **fleet schema-migration** runner.

```ts
lobby.withVaultTemplate('client', { version: 1, configure: v => v.collection('invoices') })
const group = await lobby.openVaultGroup('clients', { registry, sharding: { keyOf, vaultTemplate: 'client', autoCreate: true } })
await group.shard('acme-co').collection('invoices').put('i1', { id: 'i1', total: '1200.00' })
const all = await group.queryAcross(/* … */)          // fan-out read across shards
await group.rolloutSchema({ batchSize: 4 })             // resumable, registry-tracked
```

### 2 · Interchange — move data between vaults, safely

The full onboarding spine — **Relocate → Migrate → Merge by Authority using Provenance** — composes cleanly:

```ts
// FR-2 — Relocate: extract an FK-closed slice across vaults into one bundle
const { bundle, transferKeys } = await extractCrossVaultPartition(openVault, { seed, crossVaultRefs })

// FR-8 — Migrate-then-merge: upgrade an older-schema bundle in staging, THEN merge
const report = await migrateThenMerge(receiver, compartmentBytes, {
  transferKey, fromVersion: 0, toVersion: 1,
  migrations: { clients: [{ toVersion: 1, transform: splitFullName }] },
  strategy: 'field-authority',
  fieldAuthority: { clients: { juristicName: { authority: 'source-newest' }, nickname: { authority: 'owner', ownerSource: 'client' } } },
})
```

| Capability | What it does | API |
|---|---|---|
| **Bundle** (FR-1) | Multi-compartment `.noydb` container + pre-decrypt manifest | `@noy-db/hub/bundle` · `writeMultiVaultBundle` |
| **Relocate** (FR-2) | Cross-vault FK-closure extraction → bundle | `extractCrossVaultPartition` / `walkCrossVaultClosure` |
| **Merge** (FR-3) | Reconcile a compartment into an existing vault | `mergeCompartment` |
| **Authority** (FR-4) | Per-**field** conflict resolution (registry-newest vs owner) | `resolveFieldAuthority` · `strategy: 'field-authority'` |
| **Provenance** (FR-5) | `_source`/`_sourceTs` on writes, preserved through merge | `collection({ provenance: true })` · `getMetadata` |
| **Migrate** (FR-8) | Upgrade an incoming bundle to the receiver schema in staging | `migrateThenMerge` |
| **Export** (FR-9) | Multi-vault Excel: primary sheet + FK-referenced supporting rows | `lobby.exportMultiVaultXlsx` |

```ts
// FR-9 — one workbook spanning a client shard + the shared directory (only referenced rows)
const xlsx = await lobby.exportMultiVaultXlsx({
  primary: { vault: 'acme', seeds: { bills: () => true } },
  crossVaultRefs: [{ from: { collection: 'bills', field: 'entityId' }, to: { vault: 'directory', collection: 'entities' } }],
  sheets: { acme: [{ name: 'bills', collection: 'bills', denormalize: [{ column: 'entityName', localField: 'entityId', from: { label: 'directory', collection: 'entities', keyField: 'id', pick: 'name' } }] }],
            directory: [{ name: 'entities', collection: 'entities' }] },
})
```

### 3 · Custody — sovereign ownership without lock-in (FR-6)

The client holds an **inalienable, sealed, hidden owner** (the **Deed**) from day one; the firm operates at **100%** as a **Custodian** that *provably cannot* take ownership; an abandoned vault can be **Liberated** under an audited ceremony (the inverse of withdrawal). Inalienability is **cryptographic** — the Custodian holds the data keys but never the owner credential (sealed under a non-firm boundary).

```ts
import { createDeedOwner } from '@klum-db/lobby'              // re-exported from @noy-db/hub

await createDeedOwner(store, 'acme', 'client-acme', clientSealingProvider)   // latent owner, never authenticates
await db.grantCustodian('acme', { userId: 'firm', displayName: 'Firm', passphrase: '…' })
//  firm now operates fully — but grant / revoke / rotate / extract-and-sever all throw for a custodian
await vault.custody.liberate({ newOwnerId: 'firm-owner', newOwnerPassphrase: '…', legalBasis: 'contractual-handover' })
```

### 4 · Surface — sync only an agreed slice (FR-7)

A **Surface** is a persisted, bilaterally-agreed subset two parties sync: `{ collections, fields?, direction, conflictPolicy, cadence }`. Collections and fields **outside the surface never leave the vault** (structural projection at the export boundary).

```ts
const surface = await proposeSurface(smvA, { collections: ['compensations'], fields: { compensations: ['period', 'pnd1', 'sso'] }, direction: 'push', conflictPolicy: { strategy: 'lww-by-ts' }, cadenceMs: MONTH }, 'payroll', Date.now())
await agreeSurface(smvB, surface.id, 'tax-agent', Date.now())
const { bundleBytes, transferKey } = await lobby.exportSurface('payroll-vault', surface)   // only the 3 named fields leave
await lobby.applySurface('tax-vault', surface, bundleBytes, transferKey)
```

### On-ramp · Dock → `graduate()`

A foreign, non-noy-db unit (a legacy DB, a raw export) can't be federated directly — the sovereign tier needs a vault's keyring and per-record keys. **Dock** carries it read-only at a lower tier; **`graduate()`** imports it into a fresh sovereign vault, unlocking the full tier (custody, provenance, field-Authority merge). It's the one move that *adds a node to the data plane* rather than coordinating existing ones.

---

## Relationship with noy-db

The one-way law and the kernel seam are covered up top — here are the specifics that matter when you build:

- **Custody is a vault-level concern** and lives *in* hub (keyring/CEK/consent primitives); the Lobby **re-exports** it (`createDeedOwner`, `liberateVault`, `CustodyApi`) so consumers have one import surface.
- **Federation** lives in the Lobby, not in hub — open fleets with `lobby.openVaultGroup` (`@noy-db/hub` no longer ships the `openVaultGroup` / `openStateManagementVault` / `withVaultTemplate` fleet methods).
- **Enforced, not conventional:** an `@noy-db` package importing `@klum-db` fails noy-db's build-time architecture check.

## Status

Preview. `@klum-db/lobby` is its own repository and the sole publisher of `@klum-db/*` to npm. It depends on the **published** `@noy-db/*` packages through the stable `@noy-db/hub/kernel` boundary and versions **independently** (`0.2.0-pre.N`, decoupled from noy-db). Pilot-1 (FR-1…FR-9), the dock tier, and `Lobby.graduate()` are complete.

See [`docs/architecture.md`](docs/architecture.md) for the detailed noy-db ↔ klum-db boundary, [`docs/roadmap.md`](docs/roadmap.md) for what's next, and [`PROVENANCE.md`](./PROVENANCE.md) for origin and build history.
