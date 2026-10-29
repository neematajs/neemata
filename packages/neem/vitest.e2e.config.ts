import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'neem:e2e',
    environment: 'node',
    include: ['tests/e2e/**/*.spec.ts'],
    // Files run in parallel: each fixture gets its own temp directory and
    // every spawned host binds port 0 unless a test picks its own.
    testTimeout: 60_000,
  },
})
