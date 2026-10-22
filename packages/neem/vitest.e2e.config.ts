import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    environment: 'node',
    // Files run in parallel: each fixture gets its own temp directory and
    // every spawned host binds port 0 unless a test picks its own.
    include: ['tests/e2e/**/*.spec.ts', '../effect/tests/e2e/**/*.spec.ts'],
  },
})
