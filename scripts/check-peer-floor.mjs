// check-peer-floor — does this package actually COMPILE against the oldest
// @noy-db/* versions its peer ranges admit?
//
// Ported from noy-db-to (its PR #92), where the same gap had shipped twice.
//
// Why it is needed here too: every gate in this repo — build, lint, typecheck,
// 394 tests — resolves @noy-db/* from the exact DEV PIN in devDependencies. The
// declared peer RANGES are never exercised by anything. So a range can promise
// versions the code cannot run on and every check stays green. That is not
// hypothetical: #85 found `hasNoydbPodMagic` (hub 0.6.0-pre only) shipping
// under a range that still advertised ^0.4.0 and ^0.5.0.
//
// The hub range has now been wrong three times, each attempt stronger than the
// last. Worth knowing before anyone "restores" the old branches:
//
//   1. `^0.4.0-pre.1 || ^0.4.0 || ^0.5.0 || ^0.6.0-pre.0` — false in three of
//      four branches. Nothing checked it.
//   2. #85 narrowed it to `^0.6.0-pre.0` by reasoning about which MAJOR line
//      the symbol appeared in. Published in 0.4.0-pre.5. Still wrong, by
//      fourteen pre-releases.
//   3. #87 narrowed it to `^0.6.0-pre.14` by COMPILING against the floor — this
//      script. Checkable, and re-checked on every package.json edit and every
//      release.
//
// The family rule is "widen a peer range by APPENDING", which assumes
// compatibility only ever grows. It does not hold when upstream REMOVES a
// symbol: hub 0.6.0-pre.14 deleted hasNoydbBundleMagic with no cross-version
// successor, so the old branches had to go. Leaving them advertised converts an
// install-time refusal — loud, at the right moment — into an undefined-is-not-a-
// function at runtime in a consumer's app. Narrowing here is not a regression
// from that rule; it is the case the rule does not cover.
//
// It COMPILES rather than greps, deliberately. In noy-db-to the equivalent bug
// was `StoreLocator.register()` gaining a type parameter: the symbol existed at
// the old floor and simply could not accept the argument, so a presence check
// passed and reported a clean repo. Only a typecheck finds that class.
//
// This repo's variant differs from noy-db-to's in one way: it checks ALL five
// @noy-db peers, not just hub — including the three optional ones, which are
// exactly the peers nobody thinks about. Optional means "you may omit it", not
// "the range may be wrong".
//
// Usage:  node scripts/check-peer-floor.mjs
//         node scripts/check-peer-floor.mjs --dry-run

import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

const ROOT = resolve(fileURLToPath(import.meta.url), '../..')
const require = createRequire(import.meta.url)
const semver = require('semver')

// ── Plan (pure, exported for scripts/__tests__/check-peer-floor.test.ts) ─────
//
// Split out as pure functions purely so they can be tested. Everything below
// installs, builds and typechecks, which a unit test cannot usefully do — so
// this is the half where a regression would hide silently, and it is the half
// under test. "The gate passed" and "the gate can still fail" are different
// claims; the tests provoke it rather than observing it.
//
// Throws rather than exiting, so a caller decides what a bad range means. The
// CLI below turns that back into the same ✗ + exit 1 it always printed.

/** Lowest version each @noy-db peer range admits. Non-@noy-db peers are ignored. */
export function computeFloors(pkg) {
  const floors = {}
  for (const [name, range] of Object.entries(pkg.peerDependencies ?? {})) {
    if (!name.startsWith('@noy-db/')) continue
    let min
    try {
      min = semver.minVersion(range)
    } catch {
      // semver THROWS on an unparseable range and RETURNS NULL on a
      // well-formed range no version can satisfy (`<0.0.0`). Both are the same
      // failure to a caller, and only the second was handled before — an
      // unparseable range crashed with a stack trace instead of the message.
      min = null
    }
    if (!min) throw new Error(`${name}: cannot compute a minimum version from "${range}"`)
    // The third semver case, and the only one that fails SLOWLY. An unbounded
    // range floors at 0.0.0 — semver reads "", "   ", "*" and "x" as `*`, and
    // `<1.0.0` gets there too despite having an upper bound. No @noy-db package
    // has ever published 0.0.0, so this neither throws nor returns null: it
    // plans a check against a version that does not exist, and surfaces minutes
    // later at the install step as "no matching version for @noy-db/x@0.0.0",
    // which reads as a registry outage rather than a bad manifest.
    //
    // Detected by VALUE, not by matching the range text, because `<1.0.0` and
    // `>=0.0.0` are unbounded below without looking like wildcards.
    //
    // The range is not malformed — it is unfalsifiable. An unbounded range
    // promises every version, so there is no oldest one to check it against,
    // and a guard that cannot fail on it should say so rather than invent a
    // floor. Most plausible on the three OPTIONAL peers, where "*" gets written
    // meaning "any".
    if (min.version === '0.0.0') {
      throw new Error(
        `${name}: range "${range}" has no lower bound, so there is no floor to check it against. ` +
          `An unbounded range promises every version, including ones that were never published. ` +
          `Narrow it to the oldest version this package actually supports.`,
      )
    }
    floors[name] = min.version
  }
  return floors
}

/**
 * The floors, as a pnpm.overrides block merged into the package.json TEXT.
 * Merged rather than assigned: an existing overrides entry that is not a
 * @noy-db peer must survive, or the check silently changes what it resolves.
 */
export function applyFloorOverrides(pkgText, floors) {
  const mutated = JSON.parse(pkgText)
  mutated.pnpm = {
    ...(mutated.pnpm ?? {}),
    overrides: { ...(mutated.pnpm?.overrides ?? {}), ...floors },
  }
  return JSON.stringify(mutated, null, 2) + '\n'
}

// ── CLI ─────────────────────────────────────────────────────────────────────
//
// Guarded so importing this module from a test does not install anything. Under
// vitest process.argv[1] is vitest's own entry, so main() never runs there.
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) main()

function main() {
const DRY = process.argv.includes('--dry-run')

const rootPath = join(ROOT, 'package.json')
const rootOriginal = readFileSync(rootPath, 'utf8')
const pkg = JSON.parse(rootOriginal)

let floors
try {
  floors = computeFloors(pkg)
} catch (e) {
  console.error(`✗ ${e.message}`)
  process.exit(1)
}

const optional = new Set(Object.keys(pkg.peerDependenciesMeta ?? {}))

console.log(`Peer-floor check — ${Object.keys(floors).length} @noy-db peer(s)\n`)
for (const [name, floor] of Object.entries(floors)) {
  const tag = optional.has(name) ? ' (optional peer)' : ''
  console.log(`  ${name.padEnd(24)} ${pkg.peerDependencies[name]}`)
  console.log(`  ${''.padEnd(24)} └─ floor ${floor}${tag}`)
}
console.log()

if (DRY) {
  console.log('--dry-run: nothing installed.')
  process.exit(0)
}

// ── Execute ─────────────────────────────────────────────────────────────────
//
// Override every @noy-db peer to its floor at once. Checking them one at a time
// would be a weaker test: consumers install the whole set together, and the
// interesting failures are the ones where two floors cannot co-exist — an old
// as-xlsx peer-requiring an old hub, for instance.
const run = (cmd, args) =>
  execFileSync(cmd, args, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8', env: process.env })

const failures = []
try {
  writeFileSync(rootPath, applyFloorOverrides(rootOriginal, floors))

  console.log('── installing every @noy-db peer at its floor …')
  try {
    run('pnpm', ['install', '--no-frozen-lockfile', '--silent'])
  } catch (e) {
    // Floors that cannot even be installed together are themselves a failed
    // claim — usually two peers whose own peer requirements are incompatible.
    failures.push({ step: 'install', error: `${e.stdout ?? ''}${e.stderr ?? ''}`.slice(0, 1200) })
    throw new Error('install')
  }

  for (const step of ['build', 'typecheck']) {
    process.stdout.write(`   ${step.padEnd(10)} `)
    try {
      run('pnpm', [step])
      console.log('ok')
    } catch (e) {
      console.log('FAILED')
      const out = `${e.stdout ?? ''}${e.stderr ?? ''}`
      const errs = out.split('\n').filter((l) => /error TS|error:/.test(l)).slice(0, 6)
      failures.push({ step, error: errs.join('\n      ') || out.slice(0, 600) })
    }
  }
} catch {
  // already recorded
} finally {
  writeFileSync(rootPath, rootOriginal)
  try {
    run('pnpm', ['install', '--no-frozen-lockfile', '--silent'])
  } catch {
    console.error('\n⚠  restore install failed — run `pnpm install` before committing.')
  }
}

console.log()
if (failures.length) {
  console.error('✗ this package does not work against the floors it advertises:\n')
  for (const f of failures) console.error(`  [${f.step}]\n      ${f.error}\n`)
  console.error('Declared floors:')
  for (const [n, v] of Object.entries(floors)) console.error(`  ${n.padEnd(24)} ${v}`)
  console.error('\nEither narrow the peer range to a floor that works, or restore compatibility')
  console.error('with the older package. A range that does not compile is a false promise —')
  console.error('consumers hit it as a broken install, not as a refused one.')
  process.exit(1)
}
console.log('✓ compiles against the oldest @noy-db/* versions every peer range admits')
}
