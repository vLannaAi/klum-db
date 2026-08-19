import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// @ts-expect-error — .mjs with no type declarations; this repo typechecks src/ only.
import { publishablePackages, planAlignment, readDistTags, classifyReadback, settleReadback } from '../align-dist-tags.mjs'

// What these tests cover, and what they CANNOT.
//
// align-dist-tags.mjs has two halves, and only one is testable here:
//
//   PLAN     — publishablePackages + planAlignment. Pure. This is the half that
//              decides whether to write a dist-tag, and the half where a
//              regression is SILENT: a broken plan still exits zero and still
//              looks like a successful release.
//
//   APPLY    — `npm dist-tag add` against the live registry, then a read-back.
//              Needs network and a credential. A fixture standing in for npm
//              would test the fixture.
//
// And one property NEITHER half can reach: the workflow trigger is
// `release` + `prerelease == false`, which only fires on a real stable cut.
// That is the "a release step that inlines CI context can only be tested by
// triggering the real event" rule. It is why the script takes its registry
// state as a parameter and is runnable from a terminal — the plan can be
// exercised without a release, even though the trigger cannot.

function rootWith(pj: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'align-'))
  writeFileSync(join(root, 'package.json'), JSON.stringify(pj))
  return root
}
const withRoot = <T,>(pj: Record<string, unknown>, fn: (root: string) => T): T => {
  const r = rootWith(pj)
  try { return fn(r) } finally { rmSync(r, { recursive: true, force: true }) }
}

const PKG = '@klum-db/lobby'
const stable = [{ name: PKG, version: '0.4.0' }]

describe('publishablePackages', () => {
  it('derives the set from the root manifest rather than a hardcoded name', () => {
    withRoot({ name: '@klum-db/renamed', version: '9.9.9' }, (root) => {
      expect(publishablePackages(root)).toEqual([{ name: '@klum-db/renamed', version: '9.9.9' }])
    })
  })

  it('refuses a private package — nothing to tag', () => {
    withRoot({ name: PKG, version: '0.4.0', private: true }, (root) => {
      expect(() => publishablePackages(root)).toThrow(/private/)
    })
  })

  it('refuses a manifest with no version rather than planning against undefined', () => {
    withRoot({ name: PKG }, (root) => {
      expect(() => publishablePackages(root)).toThrow(/name\/version/)
    })
  })
})

describe('planAlignment', () => {
  it('moves @next onto the stable when @latest is already there', () => {
    const plan = planAlignment(stable, { [PKG]: { latest: '0.4.0', next: '0.4.0-pre.10' } })
    expect(plan.refusals).toEqual([])
    expect(plan.actions).toEqual([{ name: PKG, version: '0.4.0', from: '0.4.0-pre.10' }])
  })

  // THE LOAD-BEARING ASSERTION. A blind `dist-tag add` is correct when the
  // stable published and catastrophic when the version is wrong. Deleting the
  // `tags.latest !== version` guard in the script turns this and the next two
  // into failures — that is the point of writing them separately.
  it('REFUSES when @latest is not already the version — the publish did not land', () => {
    const plan = planAlignment(stable, { [PKG]: { latest: '0.3.9', next: '0.4.0-pre.10' } })
    expect(plan.actions).toEqual([])
    expect(plan.refusals[0].reason).toMatch(/expected @latest to be 0\.4\.0.*found 0\.3\.9/)
  })

  it('REFUSES when @latest is absent entirely', () => {
    const plan = planAlignment(stable, { [PKG]: { next: '0.4.0-pre.10' } })
    expect(plan.actions).toEqual([])
    expect(plan.refusals[0].reason).toMatch(/found \(none\)/)
  })

  it('REFUSES a pre-release version — alignment is for stables only', () => {
    const plan = planAlignment(
      [{ name: PKG, version: '0.4.0-pre.10' }],
      { [PKG]: { latest: '0.4.0-pre.10', next: '0.4.0-pre.10' } },
    )
    expect(plan.actions).toEqual([])
    expect(plan.refusals[0].reason).toMatch(/pre-release/)
  })

  it('REFUSES when the package has no dist-tags at all', () => {
    const plan = planAlignment(stable, {})
    expect(plan.actions).toEqual([])
    expect(plan.refusals[0].reason).toMatch(/no dist-tags/)
  })

  it('is idempotent — @next already on the stable is a skip, not an action', () => {
    const plan = planAlignment(stable, { [PKG]: { latest: '0.4.0', next: '0.4.0' } })
    expect(plan.actions).toEqual([])
    expect(plan.refusals).toEqual([])
    expect(plan.skipped[0].reason).toMatch(/already 0\.4\.0/)
  })

  it('handles a package that has never had a @next tag', () => {
    const plan = planAlignment(stable, { [PKG]: { latest: '0.4.0' } })
    expect(plan.actions).toEqual([{ name: PKG, version: '0.4.0', from: '(none)' }])
  })

  // Refusals are DATA, not exceptions, so the caller reports every problem at
  // once instead of stopping at the first. With one package that is invisible;
  // asserted anyway because the sibling repos are multi-package and this file is
  // the thing they would copy.
  it('returns refusals as data rather than throwing, reporting all at once', () => {
    const two = [
      { name: PKG, version: '0.4.0' },
      { name: '@klum-db/other', version: '0.4.0' },
    ]
    const plan = planAlignment(two, {
      [PKG]: { latest: '0.3.9', next: '0.1.0' },
      '@klum-db/other': { latest: '0.2.0', next: '0.1.0' },
    })
    expect(plan.refusals).toHaveLength(2)
    expect(plan.actions).toEqual([])
  })

  it('never emits an action alongside a refusal — alignment is all-or-nothing', () => {
    const two = [
      { name: PKG, version: '0.4.0' },
      { name: '@klum-db/other', version: '0.4.0' },
    ]
    const plan = planAlignment(two, {
      [PKG]: { latest: '0.4.0', next: '0.4.0-pre.10' },   // would be actionable alone
      '@klum-db/other': { latest: '0.3.0', next: '0.1.0' }, // but this one refuses
    })
    expect(plan.refusals).toHaveLength(1)
    // The plan still reports the actionable one; the CLI is what refuses to
    // write anything. Asserted so a future change cannot quietly make the CLI
    // apply a partial set without this test noticing the shape it relies on.
    expect(plan.actions).toHaveLength(1)
  })
})

describe('readDistTags', () => {
  it('reads through the injected view function, so the plan needs no network', () => {
    const out = readDistTags([PKG], () => ({ latest: '0.4.0', next: '0.4.0' }))
    expect(out).toEqual({ [PKG]: { latest: '0.4.0', next: '0.4.0' } })
  })
})

// ── Read-back classification ────────────────────────────────────────────
//
// Added after noy-db's 0.6.0 alignment job reported all 52 packages failed
// while all 52 had succeeded: `npm view` is CDN-served, so a read taken
// immediately after a successful write can still return the old value. The
// original version of THIS script had the identical bug — one immediate read,
// and a stale value produced `npm dist-tag add ... --otp=<code>` repair
// instructions for a tag that needed no repair.
//
// The defect is not the read. It is collapsing "could not confirm" into
// "failed", which are opposite instructions: check versus repair.

describe('classifyReadback', () => {
  const base = { version: '0.4.0', previousNext: '0.4.0-pre.10' }

  it('confirms when both tags are on the target', () => {
    expect(classifyReadback({ ...base, tags: { latest: '0.4.0', next: '0.4.0' } })).toBe('confirmed')
  })

  // THE REGRESSION THIS FILE EXISTS FOR. A successful write whose read-back
  // still shows the previous @next is CDN lag, not failure.
  it('calls a read still showing the PREVIOUS @next stale, not failed', () => {
    expect(classifyReadback({ ...base, tags: { latest: '0.4.0', next: '0.4.0-pre.10' } })).toBe('stale')
  })

  it('treats an unreadable registry response as stale rather than failed', () => {
    expect(classifyReadback({ ...base, tags: null })).toBe('stale')
  })

  // @latest is written by the PUBLISH, not by this script. If it is not on the
  // target, something outside this job's control is wrong — that is not lag.
  it('flags a wrong @latest as unexpected, not stale', () => {
    expect(classifyReadback({ ...base, tags: { latest: '0.3.9', next: '0.4.0-pre.10' } })).toBe('unexpected')
  })

  it('flags a third value nobody can explain as unexpected', () => {
    expect(classifyReadback({ ...base, tags: { latest: '0.4.0', next: '0.1.2' } })).toBe('unexpected')
  })

  it('treats a first-ever @next (no previous) that reads back wrong as unexpected', () => {
    expect(classifyReadback({ version: '0.4.0', previousNext: undefined, tags: { latest: '0.4.0', next: '0.1.2' } }))
      .toBe('unexpected')
  })
})

describe('settleReadback', () => {
  const noSleep = async () => {}
  const target = { name: '@klum-db/lobby', version: '0.4.0', previousNext: '0.4.0-pre.10' }

  it('returns as soon as the write becomes visible, without burning attempts', async () => {
    let n = 0
    const read = () => (++n < 3 ? { latest: '0.4.0', next: '0.4.0-pre.10' } : { latest: '0.4.0', next: '0.4.0' })
    const r = await settleReadback(target, { read, sleep: noSleep, attempts: 5, delayMs: 0 })
    expect(r.verdict).toBe('confirmed')
    expect(r.attempts).toBe(3)
  })

  it('gives up as STALE, never as failed, when lag outlasts the attempts', async () => {
    const read = () => ({ latest: '0.4.0', next: '0.4.0-pre.10' })
    const r = await settleReadback(target, { read, sleep: noSleep, attempts: 3, delayMs: 0 })
    expect(r.verdict).toBe('stale')
    expect(r.attempts).toBe(3)
  })

  it('short-circuits immediately on an unexpected state rather than retrying it', async () => {
    let n = 0
    const read = () => { n++; return { latest: '0.4.0', next: '0.9.9' } }
    const r = await settleReadback(target, { read, sleep: noSleep, attempts: 5, delayMs: 0 })
    expect(r.verdict).toBe('unexpected')
    expect(n).toBe(1)
  })
})
