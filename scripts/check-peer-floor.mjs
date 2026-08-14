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
const DRY = process.argv.includes('--dry-run')
const require = createRequire(import.meta.url)
const semver = require('semver')

const rootPath = join(ROOT, 'package.json')
const rootOriginal = readFileSync(rootPath, 'utf8')
const pkg = JSON.parse(rootOriginal)

// ── Plan ────────────────────────────────────────────────────────────────────
const floors = {}
for (const [name, range] of Object.entries(pkg.peerDependencies ?? {})) {
  if (!name.startsWith('@noy-db/')) continue
  const min = semver.minVersion(range)
  if (!min) {
    console.error(`✗ ${name}: cannot compute a minimum version from "${range}"`)
    process.exit(1)
  }
  floors[name] = min.version
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
  const mutated = JSON.parse(rootOriginal)
  mutated.pnpm = { ...(mutated.pnpm ?? {}), overrides: { ...(mutated.pnpm?.overrides ?? {}), ...floors } }
  writeFileSync(rootPath, JSON.stringify(mutated, null, 2) + '\n')

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
