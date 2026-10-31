import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'workflows:e2e',
    environment: 'node',
    include: ['tests/e2e/**/*.spec.ts'],
    // Like the integration suites, these run real hosts on real clocks against
    // shared servers: one file at a time, with one retry for a rare miss.
    retry: 1,
    fileParallelism: false,
    testTimeout: 60_000,
  },
})
