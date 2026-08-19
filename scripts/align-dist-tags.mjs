/**
 * Align `@next` onto a freshly published STABLE, so cutting a stable does not
 * leave `@next` pointing BEHIND `@latest`.
 *
 * Cutting `0.4.0` to `@latest` while `@next` sits at `0.4.0-pre.10` puts the
 * in-flight tag behind the stable one — the "lying tag" state the family sweep
 * flags. Measured here before this script existed: `semver.gt('0.4.0',
 * '0.4.0-pre.10')` is true, so the stable cut produces the defect BY ITSELF,
 * with no mistake by anyone. `release.yml` publishes to exactly one tag.
 *
 * The repair is an extraordinary alignment: both tags on the stable. It is
 * self-correcting — the next pre-release moves `@next` forward again.
 *
 * Stable publishes only. A pre-release already sets `@next` through the publish
 * and must never touch `@latest`.
 *
 * ── DELIBERATELY FATAL. Do not "fix" this to match the sibling script. ──
 *
 * noy-db's `repoint-pre-only-latest.mjs` is the mirror operation — moving
 * `latest` FORWARD onto a prerelease for packages with no stable — and it never
 * fails its caller. That posture is RIGHT there: a stale `latest` on a pre-only
 * package is cosmetic, and reddening a release over it only trains people to
 * stop reading the log.
 *
 * It is WRONG here. This runs as part of delivering a stable, and a half-applied
 * dist-tag state is worse than a loud failure — it is precisely the state a human
 * then has to repair by hand with an OTP. Porting a script means porting its
 * failure semantics, and those are the part most likely to be wrong in the new
 * context.
 *
 * ── Why the plan half is separated ──
 *
 * A blind `npm dist-tag add <pkg>@<version> next` is correct when the stable
 * published and catastrophic when the version input is wrong. `planAlignment`
 * refuses rather than guessing, and lives here as a pure function so that the
 * dangerous decision is testable without touching the registry.
 *
 * The trigger path (`release` + `prerelease == false`) only fires on a real
 * stable cut, so it cannot be exercised until one happens — the "a release step
 * that inlines CI context can only be tested by triggering the real event" rule.
 * That is why the version is read from the manifest and the registry is passed
 * in, keeping this runnable from a terminal:
 *
 *   node scripts/align-dist-tags.mjs            # plan only, writes nothing
 *   node scripts/align-dist-tags.mjs --apply    # writes, then re-reads
 *
 * Ported from noy-db-ui#38. The one structural difference: this repo is a SINGLE
 * package at the repo root, not a `packages/` workspace, so the package set is
 * read from the root manifest. The set is still DERIVED rather than hardcoded —
 * a hardcoded name is what broke noy-db-to's bridge twice.
 */
import { readFileSync, appendFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The publishable package set, derived from the root manifest.
 *
 * This repo ships ONE package at the repo root (the klum-db layout), so there is
 * no `packages/` directory to scan. Reading the manifest rather than writing the
 * name inline keeps the "never hardcode the set" property that matters in the
 * sibling repos, and means a rename cannot leave this script pointing at a
 * package that no longer exists.
 */
export function publishablePackages(rootDir = ROOT) {
  const pj = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'))
  if (pj.private === true) throw new Error(`${pj.name} is private; nothing to tag`)
  if (!pj.name || !pj.version) throw new Error('root package.json has no name/version')
  return [{ name: pj.name, version: pj.version }]
}

const isPrerelease = (v) => typeof v === 'string' && v.includes('-')

/**
 * Decide, per package, whether `@next` should move onto its version.
 *
 * `current` is `{ [name]: { latest, next } }` read from the registry. Refusals
 * are returned as DATA, never thrown, so the caller reports every problem at
 * once instead of stopping at the first.
 */
export function planAlignment(pkgs, current) {
  const actions = []
  const skipped = []
  const refusals = []

  for (const { name, version } of pkgs) {
    const tags = current[name]
    if (!tags) {
      refusals.push({ name, reason: `no dist-tags on the registry for ${name}` })
      continue
    }
    if (isPrerelease(version)) {
      refusals.push({ name, reason: `${name}@${version} is a pre-release; alignment is for stables only` })
      continue
    }
    // THE BEFORE-STATE ASSERTION. If @latest is not already this version, either
    // the publish did not land or the version input is wrong — and in both cases
    // writing @next here would point it at something unverified.
    if (tags.latest !== version) {
      refusals.push({
        name,
        reason: `${name}: expected @latest to be ${version} after publish, found ${tags.latest ?? '(none)'}`,
      })
      continue
    }
    if (tags.next === version) {
      skipped.push({ name, reason: `${name}: @next is already ${version}` })
      continue
    }
    actions.push({ name, version, from: tags.next ?? '(none)' })
  }

  return { actions, skipped, refusals }
}

/** Read `{ latest, next }` per package from the registry. */
export function readDistTags(names, view = npmView) {
  const out = {}
  for (const n of names) out[n] = view(n)
  return out
}

function npmView(name) {
  try {
    return JSON.parse(execFileSync('npm', ['view', name, 'dist-tags', '--json'], { stdio: 'pipe' }).toString())
  } catch {
    return null
  }
}

function main() {
  const apply = process.argv.includes('--apply')
  const pkgs = publishablePackages()
  const { actions, skipped, refusals } = planAlignment(pkgs, readDistTags(pkgs.map((p) => p.name)))

  for (const s of skipped) console.log(`  = ${s.reason}`)
  for (const a of actions) console.log(`  → ${a.name}: @next ${a.from} → ${a.version}`)
  for (const r of refusals) console.error(`  ✗ ${r.reason}`)

  if (refusals.length) {
    console.error('\nRefusing to move any tag. Alignment is all-or-nothing: a partial move leaves the')
    console.error('tags in a state nobody designed.')
    process.exit(1)
  }
  if (!apply) {
    console.log('\n--apply not given; nothing written.')
    process.exit(0)
  }

  for (const a of actions) {
    execFileSync('npm', ['dist-tag', 'add', `${a.name}@${a.version}`, 'next'], { stdio: 'inherit' })
  }

  // A zero exit is not evidence the tag moved. Re-read the registry.
  const after = readDistTags(pkgs.map((p) => p.name))
  const summary = []
  let bad = 0
  for (const { name, version } of pkgs) {
    const t = after[name]
    const ok = t?.next === version && t?.latest === version
    console.log(`  ${ok ? '✓' : '✗'} ${name}: latest=${t?.latest} next=${t?.next}`)
    summary.push(`- ${ok ? '✓' : '⚠️'} \`${name}\` — latest=\`${t?.latest}\` next=\`${t?.next}\``)
    if (!ok) {
      // The repair needs an OTP from a workstation — CI cannot supply one — so
      // hand over the exact command rather than leaving whoever reads this to
      // reconstruct it under time pressure.
      summary.push(`    recover with: \`npm dist-tag add ${name}@${version} next --otp=<code>\``)
      bad++
    }
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### dist-tag alignment\n\n${summary.join('\n')}\n\n`)
  }

  if (bad) {
    console.error(`\n✗ ${bad} package(s) did not land as expected.`)
    process.exit(1)
  }
  console.log('\n✓ @latest and @next both on the stable')
}

// vitest's process.argv[1] is vitest's own entry, so main() never runs there.
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) main()
