import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    environment: 'node',
    // Files run in parallel: each fixture gets its own temp directory and
    // every spawned host binds port 0 unless a test picks its own.
    include: ['tests/e2e/**/*.spec.ts', '../effect/tests/e2e/**/*.spec.ts'],
    // Tests spawn builds and hosts next to each other, which takes seconds on
    // small CI runners. Their own waits fail sooner and report details.
    testTimeout: 60_000,
  },
})
