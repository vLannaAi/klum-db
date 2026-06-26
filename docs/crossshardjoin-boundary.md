# Cross-shard join boundary — why `JOIN` stays in-vault

**Issue #11.** Companion to the forthcoming `docs/federation.md` (#9).

---

## The rule in one sentence

The SQL/query `JOIN` keyword is a vault primitive: it correlates collections **within one vault**. Correlating records across shards is done through the **programmatic federation API only** — `ShardedQuery.crossShardJoin` and `ShardedQuery.broadcastJoin`. There is no cross-vault extension of the query grammar, and that is an invariant, not an omission.

---

## In-vault `.join()` — what it is and where it lives

Inside a single `@noy-db` vault the query DSL exposes a `.join(field, opts)` step. It resolves the right-side collection from a `ref()` declared on the template's collection options:

```ts
// noy-db template (single vault)
vault.collection('invoices', {
  refs: { clientId: ref('clients') },
})

// in-vault join — correlates within this vault only
vault.collection('invoices').query().join('clientId', { as: 'client' }).toArray()
```

The vault resolves the `ref`, hydrates the right collection, and attaches the matching right record under `as`. This is entirely **self-contained**: a vault's query knows only its own collections; no cross-vault identifier ever touches the grammar.

---

## No cross-vault `JOIN` keyword — by invariant

The `@noy-db` query grammar is **never extended across the vault boundary**. There is no `ShardedQuery.join(...)` that routes to a different vault. Cross-vault correlation goes through two explicit, named federation API methods:

| Method | Class | Source |
|---|---|---|
| `.crossShardJoin(field, opts)` | `ShardedQuery` | `src/federation/vault-group.ts:591` |
| `.broadcastJoin(field, opts)` | `ShardedQuery` | `src/federation/vault-group.ts:603` |

Both are defined on `ShardedQuery`, not on `Collection` or the noy-db query type. The naming difference from `.join()` is deliberate: it signals "orchestration surface" rather than "vault primitive."

---

## The two join shapes

### Co-partitioned — `crossShardJoin`

**Pattern:** each shard joins its `field` against a **same-vault right collection** (declared via `ref()` on the template). The per-shard fan-out callback calls the ordinary in-vault `.join()` on each shard's query object; results union across shards after all per-shard callbacks complete.

**How it executes** (`src/federation/vault-group.ts:621–671`):

1. `fanoutRecords` resolves eligible shards (`resolveEligible`).
2. Before fanning out, it probes one shard for every co-partitioned leg: if `vault.resolveRef(collectionName, leg.field)` returns nothing, it throws **one** `CrossShardJoinError` (lines 626–638) rather than N identical per-shard errors.
3. Inside the `queryAcross` callback (lines 648–663), the hydration step opens the right collection (`vault.collection(desc.target).list()`), then chains `.join(leg.field, { as, maxRows, strategy })` on the shard's query — this is the ordinary in-vault `.join()`.
4. Results from all shards are concatenated into a flat union.

**Constraint:** the right collection must live in the same vault as the left collection — i.e. the template must declare `refs: { [field]: ref('<target>') }`. A missing ref is a configuration error, not a silent empty join.

**Options** (`src/federation/cross-shard-join.ts:16–23`):

```ts
interface CrossShardJoinOptions {
  as: string           // alias key on each output row
  maxRows?: number     // per-shard row ceiling
  strategy?: JoinStrategy  // planner hint, passed to in-vault .join()
}
```

### Broadcast — `broadcastJoin`

**Pattern:** a single shared **dimension** collection (a `BroadcastSource`, typically a `Collection` from a separate vault) is loaded **once**, indexed by its `on` key, and attached to every merged row centrally. It is a post-merge map-attach, not a per-shard operation.

**How it executes** (`src/federation/cross-shard-join.ts:99–128`):

```
applyBroadcastLegs(rows, legs)
  for each leg → leg.from.list() once → build Map<key, record>
  for each row  → attach { [as]: map.get(row[field]) ?? null }
```

The function is called after `fanoutRecords` returns the unioned rows: `src/federation/vault-group.ts:709` (in `toArray`) and line 737 (in the `live()` compute callback).

A miss (no matching dimension row) is governed by `mode`:
- `'warn'` (default): attaches `null` and emits a one-shot `console.warn`, deduped by `field→as:key` (`cross-shard-join.ts:78–87`).
- `'cascade'`: attaches `null` silently.

**Options** (`src/federation/cross-shard-join.ts:36–45`):

```ts
interface BroadcastJoinOptions {
  as: string              // alias key on each output row
  from: BroadcastSource   // shared dimension (any object with .list())
  on?: string             // right-side key (default 'id')
  mode?: 'warn' | 'cascade'
}
```

---

## Comparison table

| | In-vault `.join()` | `crossShardJoin` | `broadcastJoin` |
|---|---|---|---|
| **API surface** | `Collection.query().join(field, opts)` | `ShardedQuery.crossShardJoin(field, opts)` | `ShardedQuery.broadcastJoin(field, opts)` |
| **Where declared** | noy-db query DSL (vault primitive) | `vault-group.ts:591` | `vault-group.ts:603` |
| **Right side** | Same vault — resolved via `ref()` on template | Same vault as each left shard — resolved via `ref()` per shard | Any `BroadcastSource` (typically a separate vault) |
| **Execution site** | Inside the vault, per query | Inside each shard's fan-out callback (calls in-vault `.join()`) | Centrally, after all shard results merge (`applyBroadcastLegs`) |
| **Miss behavior** | Null attach (vault-level) | Throws `CrossShardJoinError` if ref missing | `null` + optional warn / cascade |
| **Grammar layer** | Vault primitive | Federation orchestration | Federation orchestration |

---

## Why the boundary holds — the rationale

Cross-vault correlation is **orchestration**, not a vault primitive. Extending the query grammar to express cross-vault `JOIN` would:

1. **Leak cross-vault structure into a vault's own query surface.** A vault's template, index, and query planner know only that vault's schema. A cross-vault grammar step would need a vault to reason about another vault's layout — breaking the self-contained model.

2. **Invite unbounded query semantics (grammar creep).** Once a cross-vault `JOIN` exists in the grammar, the natural next requests are `ORDER BY` across the join, `WHERE` on the right side before the join, sub-joins, etc. Each addition either requires a distributed query planner inside the vault (wrong layer) or ships half-formed semantics. A programmatic API bounds this surface precisely: what the two methods accept is the full contract.

3. **Break the "a vault's query is self-contained" property.** The noy-db guarantee is that everything a vault needs to answer a query lives in that vault's store. A cross-vault grammar extension violates this: the vault would need a network call mid-query to satisfy the right side, with no clear consistency model, no transaction boundary, and no way to enforce data-residency constraints in the query planner.

Keeping cross-shard correlation as an explicit, named programmatic step makes the cross-vault boundary **visible at the call site**. A reader of `shardedQuery.crossShardJoin(...)` knows they are at the federation layer, not inside a vault.

---

## Composition with reactive and aggregate surfaces

`ShardedQuery` with join legs composes with `.live()`, `.aggregate()`, and `.groupBy().aggregate()` — added in #14. In every case the join is still expressed via the programmatic `crossShardJoin` / `broadcastJoin` API; the reactive and aggregate surfaces sit **above** the join step, not below it.

- **`.live()`** (`vault-group.ts:732`): recomputes the full joined snapshot on writes to the primary collection. Broadcast and co-partitioned legs are applied in the compute callback (`fanoutRecords` → `applyBroadcastLegs`).
- **`.aggregate()` / `.groupBy().aggregate()`**: `aggregateSource()` (`vault-group.ts:761`) detects join legs. With no legs it returns the partial-reduce-eligible `ShardedQuery` (distributed partial-reduce, #8). With join legs it falls back to a `toArray`-backed source (central reduce over the fully-joined rows), because partial-reduce cannot span the post-merge broadcast-attach step.

No aggregate or live shorthand introduces a cross-vault `JOIN` keyword. The programmatic boundary is invariant across all composition surfaces.
