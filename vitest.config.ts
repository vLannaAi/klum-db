import { defineConfig } from 'vitest/config'

// Two projects, because the repo has two bodies of testable code and only one of
// them used to be reachable. `include` was rooted at the repo with a single
// `__tests__/**` glob, so anything under `scripts/` was never collected — a test
// written at `scripts/__tests__/` would silently never run, which is the exact
// unexecuted-claim pattern check-peer-floor.mjs exists to prevent.
//
// Verified by writing a deliberately failing test and watching it fail before
// any real assertion was written. A collection config that has never been seen
// to collect is itself an unexecuted claim.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'lobby',
          include: ['__tests__/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'scripts',
          root: './scripts',
          include: ['__tests__/**/*.test.ts'],
          environment: 'node',
        },
      },
    ],
  },
})
