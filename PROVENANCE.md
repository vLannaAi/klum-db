# Provenance

This repository (`@klum-db/lobby`) was extracted from the
[`vLannaAi/noy-db`](https://github.com/vLannaAi/noy-db) monorepo at commit
**`015d52af`** (2026-06-18), where it lived at `packages/lobby`. It now stands
alone as the **outward** orchestration framework to noy-db's **inward** vault:
it coordinates a group of sovereign noy-db vaults across federation,
interchange, custody, and surface sync. Here it is the package at the repository
root — a single-package repo, not a monorepo.

## Standalone & publishing

`klum-db` is now a **separate repository** with a strictly one-way relationship
to noy-db, and the **sole publisher** of `@klum-db/*` to npm. The dependency
runs only `@klum-db/lobby` → `@noy-db/hub` (+ the `/kernel` and `/bundle`
subpaths) and `@noy-db/as-xlsx`, bound through the **published** packages —
never a workspace link, never hub internals. No `@noy-db` package depends on
`@klum-db` (enforced on the noy-db side by its `no-outbound-klum-import`
architecture guard).

## Dependencies

This package depends on the published `@noy-db/*` packages via the peer-dep
range `^0.2.0-pre.24`:

- `@noy-db/hub` (peer + dev)
- `@noy-db/as-xlsx` (peer + dev)
- `@noy-db/to-memory` (dev/test only)

Versioning is **independent** of noy-db: this repo bumps its own
`0.2.0-pre.N`, while noy-db can advance within the peer-dep range without
forcing a bump here. The test suite runs against the *published* `@noy-db`,
validating the kernel boundary across the real published-package seam.

## Build history

The per-FR build history (FR-1…FR-9) lives in the noy-db pull requests
**#454–#467**; the dock tier and `Lobby.graduate()` were added here. The repo
was published with a condensed history.
