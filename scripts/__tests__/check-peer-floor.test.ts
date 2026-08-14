import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

// @ts-expect-error — .mjs with no type declarations; this repo typechecks src/ only.
import { applyFloorOverrides, computeFloors } from '../check-peer-floor.mjs'

const require = createRequire(import.meta.url)
const semver = require('semver')

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

// What these tests do and do NOT cover, stated plainly so the coverage is not
// overread. check-peer-floor.mjs has two halves:
//
//   PLAN     — read peer ranges, compute each floor, build a pnpm.overrides
//              block. Pure, fast, and the half where a regression is silent.
//              That is what is tested here.
//   EXECUTE  — install at those floors, then build and typecheck. Needs the
//              network and minutes, and is exercised for real by the `peer-floor`
//              CI job on every package.json edit and every release.
//
// So a green run here does NOT mean the guard would catch a false range; it
// means the guard is still asking the right question. The CI job is what proves
// it can still answer it.

describe('computeFloors', () => {
  it('computes a floor for every @noy-db peer, and each floor satisfies its own range', () => {
    const floors = computeFloors(pkg)
    const declared = Object.keys(pkg.peerDependencies).filter((n) => n.startsWith('@noy-db/'))

    expect(Object.keys(floors).sort()).toEqual(declared.sort())
    expect(declared.length).toBeGreaterThan(0)

    for (const [name, floor] of Object.entries(floors)) {
      expect(
        semver.satisfies(floor, pkg.peerDependencies[name], { includePrerelease: true }),
        `${name} floor ${floor} does not satisfy its own range ${pkg.peerDependencies[name]}`,
      ).toBe(true)
    }
  })

  it('includes the optional peers — optional means the consumer may omit it, not that the range may be wrong', () => {
    const floors = computeFloors(pkg)
    const optional = Object.keys(pkg.peerDependenciesMeta ?? {}).filter((n) => n.startsWith('@noy-db/'))

    expect(optional.length).toBeGreaterThan(0)
    for (const name of optional) expect(floors).toHaveProperty(name)
  })

  it('keeps the hub floor above the versions that removed the symbols this package imports', () => {
    // Deliberately an invariant rather than a pinned version, so a legitimate
    // future bump does not break it while a re-widening does. hub 0.6.0-pre.14
    // is where hasNoydbPodMagic landed; anything below it cannot build this
    // package. The range was wrong three times (#85 twice, #87 fixed it) — this
    // is the assertion that makes a fourth attempt fail loudly.
    const range = pkg.peerDependencies['@noy-db/hub']
    for (const tooOld of ['0.4.0', '0.5.0', '0.6.0-pre.0', '0.6.0-pre.13']) {
      expect(
        semver.satisfies(tooOld, range, { includePrerelease: true }),
        `hub range ${range} admits ${tooOld}, which predates hasNoydbPodMagic`,
      ).toBe(false)
    }
    expect(semver.satisfies(computeFloors(pkg)['@noy-db/hub'], range, { includePrerelease: true })).toBe(true)
  })

  it('ignores peers outside the @noy-db scope', () => {
    const floors = computeFloors({
      peerDependencies: { '@noy-db/hub': '^0.6.0-pre.14', react: '^18.0.0', '@klum-db/other': '^1.0.0' },
    })
    expect(Object.keys(floors)).toEqual(['@noy-db/hub'])
  })

  it('returns nothing rather than throwing when there are no peers at all', () => {
    expect(computeFloors({})).toEqual({})
    expect(computeFloors({ peerDependencies: {} })).toEqual({})
  })

  it('reports an unparseable range instead of crashing', () => {
    // semver.minVersion THROWS here. Before the split this escaped as a raw
    // stack trace; the `if (!min)` guard only caught the null case below.
    expect(() => computeFloors({ peerDependencies: { '@noy-db/hub': 'not-a-range' } })).toThrow(
      /@noy-db\/hub: cannot compute a minimum version from "not-a-range"/,
    )
  })

  it('reports a well-formed range that no version can satisfy', () => {
    // semver.minVersion RETURNS NULL here rather than throwing — a different
    // path to the same failure, which is why both are handled.
    expect(() => computeFloors({ peerDependencies: { '@noy-db/hub': '<0.0.0' } })).toThrow(
      /cannot compute a minimum version/,
    )
  })

  it('takes the lowest version across a multi-branch range, not the first branch written', () => {
    const floors = computeFloors({
      peerDependencies: { '@noy-db/as-xlsx': '^0.5.0 || ^0.4.0-pre.0 || ^0.6.0-pre.0' },
    })
    expect(floors['@noy-db/as-xlsx']).toBe('0.4.0-pre.0')
  })
})

describe('applyFloorOverrides', () => {
  const floors = { '@noy-db/hub': '0.6.0-pre.14' }

  it('writes the floors into pnpm.overrides', () => {
    const out = JSON.parse(applyFloorOverrides(JSON.stringify({ name: 'x' }), floors))
    expect(out.pnpm.overrides).toEqual(floors)
  })

  it('preserves an unrelated existing override', () => {
    // A merge, not an assignment. Dropping a pre-existing override would change
    // what the check resolves — so it would be checking a tree no consumer has.
    const text = JSON.stringify({ pnpm: { overrides: { lodash: '4.0.0' } } })
    const out = JSON.parse(applyFloorOverrides(text, floors))
    expect(out.pnpm.overrides).toEqual({ lodash: '4.0.0', '@noy-db/hub': '0.6.0-pre.14' })
  })

  it('preserves other keys under pnpm', () => {
    const text = JSON.stringify({ pnpm: { peerDependencyRules: { ignoreMissing: ['x'] } } })
    const out = JSON.parse(applyFloorOverrides(text, floors))
    expect(out.pnpm.peerDependencyRules).toEqual({ ignoreMissing: ['x'] })
  })

  it('overwrites a stale floor for a package it manages', () => {
    const text = JSON.stringify({ pnpm: { overrides: { '@noy-db/hub': '0.1.0' } } })
    expect(JSON.parse(applyFloorOverrides(text, floors)).pnpm.overrides['@noy-db/hub']).toBe('0.6.0-pre.14')
  })

  it('leaves every other field of package.json intact', () => {
    // The restore path rewrites the ORIGINAL text, so this function must never
    // be the reason a field goes missing.
    const original = JSON.stringify({ name: '@klum-db/lobby', version: '9.9.9', scripts: { test: 'vitest run' } })
    const out = JSON.parse(applyFloorOverrides(original, floors))
    expect(out.name).toBe('@klum-db/lobby')
    expect(out.version).toBe('9.9.9')
    expect(out.scripts).toEqual({ test: 'vitest run' })
  })

  it('does not mutate the text it was given', () => {
    const original = JSON.stringify({ name: 'x' })
    const copy = String(original)
    applyFloorOverrides(original, floors)
    expect(original).toBe(copy)
  })

  it('emits parseable JSON ending in a newline', () => {
    const out = applyFloorOverrides(readFileSync(join(ROOT, 'package.json'), 'utf8'), floors)
    expect(out.endsWith('\n')).toBe(true)
    expect(() => JSON.parse(out)).not.toThrow()
  })

  it('round-trips the real package.json with the real floors', () => {
    const text = readFileSync(join(ROOT, 'package.json'), 'utf8')
    const out = JSON.parse(applyFloorOverrides(text, computeFloors(pkg)))
    for (const [name, floor] of Object.entries(computeFloors(pkg))) {
      expect(out.pnpm.overrides[name]).toBe(floor)
    }
    expect(out.peerDependencies).toEqual(pkg.peerDependencies)
  })
})
