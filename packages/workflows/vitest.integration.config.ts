import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'workflows:integration',
    environment: 'node',
    include: ['tests/integration/**/*.spec.ts'],
    // Integration scenarios race real workers and processes on real clocks:
    // one retry absorbs a rare miss under load without hiding a regression.
    retry: 1,
    // They spawn processes and hold many connections to servers they share;
    // one file at a time keeps their deadlines meaningful.
    fileParallelism: false,
    testTimeout: 60_000,
  },
})
