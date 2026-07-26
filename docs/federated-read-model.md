# Federated read-model over a VaultGroup — spec (DRAFT for review)

> Deliverable of #44. A maintained, queryable read-model spanning a `VaultGroup` —
> the cross-shard rollup + row-projection layer every federated consumer currently
> hand-rolls. Status: **draft — review before implementation slices are filed.**

## Division of labor (the load-bearing decision)

Hub #810's projection MV and the Via engine are **within-shard** machinery, and
`materializedViewStrategies` is a `createNoydb` option — **the consumer registers
it; the Lobby never constructs the consumer's `Noydb`**. So the split is:

- **Consumer (per shard, hub machinery)**: enrich/join/derive *inside* each shard —
  e.g. an #810 projection MV materializing `bills-view` (bill + entityName +
  collected payments) as an ordinary collection in that shard.
- **Lobby (cross-shard, this spec)**: maintain a **read-model vault** that composes
  per-shard collections (plain or MV-output — the Lobby is deliberately agnostic)
  across the group, in two shapes:
  1. **Rollup** — per-shard reduce → one summary row per shard (+ optional fold);
     the maturation of today's `withCrossVaultDerivation`.
  2. **Mirror** (row projection) — per-shard row-level replication of a source
     collection into one group-wide queryable collection, id-namespaced by shard.

The read side is deliberately boring: the read-model is an ordinary vault; pages
query it with the normal collection API. One vault, one query, never N shard opens.

## API sketch

```ts
const rm = await lobby.openReadModel(group, {
  vault: 'insight--firm',                    // the read-model vault (consumer-created,
                                             // like every vault the Lobby touches)
  models: [
    { // shape 1 — rollup (generalizes withCrossVaultDerivation)
      name: 'firm-billing',
      kind: 'rollup',
      source: 'bills',
      derive: (records, ctx) => ({ period: ctx.period, billed: sum(...), count: records.length }),
      posture: { surface: ['period', 'billed', 'count'] },
    },
    { // shape 2 — mirror (the cross-shard half of #810)
      name: 'all-bills',
      kind: 'mirror',
      source: 'bills-view',                  // typically an #810 projection MV output
      posture: { surface: ['entityName', 'amount', 'status', 'period'] },
    },
  ],
  freshness: { autoPush: { debounceMs: 250 } },   // reuse the #13 controller; default explicit-only
})

await rm.refresh()                            // explicit refresh (parity with refreshInsights)
rm.collection('all-bills').query().where('status', '==', 'overdue')   // ordinary reads
```

## Decisions

### 1 · Row identity & provenance (parity-bearing)

Deterministic ids — mirror: `${partitionKey}:${sourceRecordId}`; rollup:
`${partitionKey}` (or `${partitionKey}:${groupKey}` when the reducer emits
per-key rows). Every read-model row carries `_shard: partitionKey` and
`_sourceVersion` so byte-exact parity vs the pre-federation monolith is
checkable per row, and skipped-shard gaps are attributable.

### 2 · Posture: explicit surface allowlist (ZK boundary)

`posture.surface` is **required** on every model. At push time each emitted row
is checked: an undeclared field **fails closed** (typed error, the push is
rejected — not silently stripped, so a leaking `map` is caught in development,
not production). Only the declared shape crosses the DEK boundary, re-encrypted
under the read-model vault's key by the ordinary `put` pipeline. Shard
ciphertext never crosses; the Lobby never decrypts anything the reading session
could not already read (it runs in a session holding shard grants — same
posture as today's Insight Vault, now with the surface made explicit, akin to
Via's `ViaPosture`).

### 3 · Freshness: reuse the auto-push controller (#13)

Per-shard writes to a model's `source` re-derive **that shard's contribution
only** — no full fan-out. Mirror pushes are per-record (change event → one row
put/delete); rollup pushes re-reduce the one shard (existing behavior).
`autoPush` defaults **off** (explicit `rm.refresh()`), tunable with the #13
debounce/minVersion knobs. A consumer whose shard MV refreshes lazily gets
eventual freshness bounded by the MV's own staleness — the Lobby does not
force-refresh hub MVs (their `refreshOnRead`/staleness contract is the hub's).

### 4 · Deletes & retraction

Mirror: a source delete (or, for MV sources, a refresh-driven omit) deletes the
mirrored row — driven by the same change events the auto-push controller
already consumes; ids being deterministic makes retraction a keyed delete, no
scan. Rollup: the shard's summary row is re-put wholesale (current semantics).
A shard leaving the group retracts all its rows on the next refresh.

### 5 · Scopes: audience = vault, subset = shards

A read-model instance is scoped by **(a)** which vault it targets and **(b)**
which shards feed it — `openReadModel(group, { shards?: (row) => boolean })`.
Per-advisor scope = a separate read-model vault fed by that advisor's shard
subset, refreshed by a session holding exactly those grants (no-grant shards
surface as `skippedVaults`, the existing classification — never silently
dropped). **No partial-row redaction in v1**: scope by shard subset + posture
only. Per-period scoping is a reducer/`map` concern (period lands in the row;
readers filter), not an engine feature.

### 6 · Relationship to existing machinery

- `withCrossVaultDerivation` **stays** (shipped API); `kind: 'rollup'` is its
  successor inside the read-model frame. Internally one engine; the old entry
  point becomes a thin adapter. No breaking change.
- `crossShardJoin` stays the *ad-hoc* cross-shard read; the read-model is the
  *maintained* one. A page that needs it fresh-now joins; a page that needs it
  cheap reads the model.
- Consumer requirement (documented, README): shards feeding a mirror of an MV
  output must be opened by sessions registering that MV
  (`materializedViewStrategies: [withMaterializedView({ projection: … })]`) —
  the same opt-in-strategy pattern as `withCargo`/`withSearch`/`withTeam`.

### 7 · Determinism (parity harness)

`derive`/posture filtering must be pure (no clock, no randomness — the engine
passes `ctx.now` where a timestamp is legitimately needed). The parity harness
(final slice) replays a monolith fixture through a sharded group and asserts
row-for-row equality of the read-model against the monolith computation.

## Non-goals (v1)

- Cross-shard JOIN legs *inside* the read-model (a mirror row joining another
  shard's data) — compose per-shard #810 legs instead; revisit with evidence.
- Live/reactive queries over the read-model beyond what plain collections give.
- Read-model-of-read-model chaining; multi-group models.
- Per-row redaction by audience (scope = shard subset + posture only).

## Slices

1. **S1 — engine + rollup**: `openReadModel`, deterministic ids/provenance,
   posture check, explicit `refresh()`; `withCrossVaultDerivation` adapter.
2. **S2 — mirror shape**: per-record push/retract, MV-source freshness
   semantics, delete handling.
3. **S3 — auto-push integration**: #13 controller wiring, per-shard coalescing,
   `skippedVaults` reporting on partial refresh.
4. **S4 — scoped audiences + parity harness**: shard-subset scoping, the
   niwat-shaped monolith-parity fixture.

No cross-repo asks: hub #810 + the existing `/cargo` seam suffice. (If S2 finds
the MV staleness contract insufficient for mirror freshness, that becomes a
noy-db `[port]` issue — coordinate, don't reach through.)
