# Roadmap — next features

Where `@klum-db/lobby` goes next. Each item notes **what** it is, **why it's the Lobby's** (per the [boundary law](./architecture.md#the-boundary-law--deciding-what-goes-where)), **what it builds on**, and rough **scope**. Ordered by readiness × value.

Shipped through `@klum-db/lobby@0.2.0-pre.30`: the four pillars (Federation, Interchange, Custody re-export, Surface), Dock → `graduate()`, the WS-3 federation tooling (`groupInspector` / `meterGroup` / `klum` CLI), the Transform/Cutover/**Rollout** vocabulary + the `migrate*`→`rollout*`/`cutover*` rename, and optional tooling peers.

---

## 1 · Session-consolidation orchestrator (#469 Slice 4) — **next up**

**What:** drive the new kernel **`CoordinationProvider`** drain-barrier across a `VaultGroup`, consolidated **per session/user** — so a user holding 15 vaults gets **one** pause for a fleet schema cutover, not 15 stop/close/reopen cycles. The fence completes per-vault (for correctness); the *experience* batches per session.

**Why klum:** the barrier *mechanism* is noy's (a single vault's concurrency control, [now a kernel port](./architecture.md#the-recurring-pattern--dependency-inversion-ports)); the *cross-vault consolidation* is pure orchestration — it spans many vaults and rides on the published port. Textbook Lobby work.

**Builds on:** `@noy-db@pre.27` — `noydb.coordination` exposes the port; `WriterPresence.sessionId` is carried for grouping; `runDrainBarrier`/`isQuorum` are reusable. klum drives them through the handle, **no `by-*` dependency**.

**Scope:** a `Lobby`-level "rollout over live writers" that groups fences by `sessionId` while completing by vault; surfaces "waiting on other users" for offline writers. Pairs with §4. Spec: noy-db `docs/superpowers/specs/2026-06-20-coordination-port-469-design.md` ("Slice 4, out of scope there").

---

## 2 · Blue-green Rollout strategy

**What:** a cross-vault schema migration as a first-class `Lobby` strategy — stand up a **new-schema vault**, transform-copy the data across, flip clients, retire the old. The alternative to noy's in-place fence Cutover.

**Why klum:** moving data *between* vaults is cross-vault by construction. The Transform stays noy (it re-keys records); the *choreography* (provision → copy → flip the client→vault pointer in the StateManagement registry → retire) is the Lobby's.

**Builds on:** `extractCrossVaultPartition` + `migrateThenMerge` (already shipped) + the StateManagement vault registry for the old→new pointer.

**Scope:** `lobby.migrateVaultToNewSchema(old → new, transform)`. Bonus: it closes the **offline-by-peer** gap — late writes land in the still-living old vault and get re-transformed, which in-place Cutover can't do. See [glossary strategy axis](./glossary/schema-migration.md#strategy-axis-orthogonal-to-the-ladder).

---

## 3 · Cross-vault transfer orchestrator

**What:** `Lobby.transferPartition(fromVault → toVaultRef, …)` choreographing a partition handoff between two vaults in a group: `extractPartition` → `adoptPartition` → `createOwnerOnAdoptedPartition` → destroy the transfer seal.

**Why klum:** genuinely crosses the vault/store boundary (sender → recipient). The crypto primitives stay noy (`@noy-db/hub/bundle`); the Lobby sequences them — the one transfer capability the WS-2 governance analysis surfaced as legitimately klum's (the in-place custody/withdrawal ceremonies stayed in noy).

**Builds on:** the published transfer/adopt primitives in `@noy-db/hub/bundle`.

**Scope:** net-new orchestration over public primitives; justified by a real fleet-handoff scenario (moving a client's vault between shards/regions).

---

## 4 · Fleet Rollout enrichment

**What:** make `rolloutSchema` operable for real fleets — **progress** reporting, **partial-fleet rollback**, **pause/resume**, and cohort/canary controls beyond today's batch runner.

**Why klum:** the per-shard `cutoverShard` (which drives noy's barrier) is done; this is the *fleet state machine* around it — registry-driven, observable, resumable. Pure orchestration.

**Builds on:** today's `rolloutSchema` / `cutoverShard` + the StateManagement migration-status rows + (from §1) the consolidated barrier.

**Scope:** incremental hardening of the existing runner; pairs naturally with §1.

---

## 5 · Federation follow-ups (#12 epic tail)

- **Insight auto-push-on-write** — refresh firm-wide Insight rollups incrementally as shards write, rather than on an explicit `refreshInsights`.
- **Offline-shard consistency** — define + test convergence when a shard is unreachable during a fan-out / rollout (surfaced, not silently dropped — the `skipped` set already models this; harden the read-after-rejoin path).

**Why klum:** both are cross-shard consistency concerns — fleet-level, the Lobby's.

---

## 6 · Group tooling completion

- **Group TUI mode** — wire `groupInspector` into the Ink TUI so an operator browses a *federation* (the one WS-3 piece with real UI work; the CLI already ships).
- **CLI `--meter` operational wrapping** — the `klum` CLI parses `--meter` but defers the `toMeter` store-wrapping; complete it so `inspect-group --meter` shows live store metrics alongside the shape metrics.

**Why klum:** both extend the group-tooling adapters that already live here; they only consume noy's vault-shape-agnostic contracts.

---

## Notes

- **Independent versioning:** ship each as its own `0.2.0-pre.N` here; noy advances within the `^0.2.0-pre.26` peer range without forcing a bump (see [architecture §Versioning](./architecture.md#versioning--the-published-package-seam)).
- **Anything requiring a new noy primitive** (e.g. a coordination join-handshake for late-joiners) is a **noy-db** change first, published, then consumed here — relocations/contract changes are choreographed across the seam, no-gap.
