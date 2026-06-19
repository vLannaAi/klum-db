# Provenance

This repository (`@klum-db/lobby`) was extracted from the
[`vLannaAi/noy-db`](https://github.com/vLannaAi/noy-db) monorepo at commit
**`015d52af`** on **2026-06-18** — Phase 1 of the klum-db extraction (stand up
the standalone repo and prove it builds/tests against the published
`@noy-db/*` packages).

## What this repo is

The Lobby is the *outward* orchestration framework to noy-db's *inward*
vault: it coordinates a group of sovereign noy-db vaults (federation,
interchange, custody). In the monorepo this lived at
`packages/lobby`; here it is the package at the repository root (a
single-package repo, not a monorepo).

## Build history

The full per-FR build history lives in the noy-db pull requests
**#454–#467**.

## Dependencies

This package depends on the published `@noy-db/*` packages at
**`0.2.0-pre.24`** (on npm):

- `@noy-db/hub` (peer + dev)
- `@noy-db/as-xlsx` (peer + dev)
- `@noy-db/to-memory` (dev/test only)

Phase 1 validates that these published packages expose a sufficient
kernel surface for the Lobby to build and pass its full test suite
without reaching into monorepo-internal paths.
