import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'effect:e2e',
    environment: 'node',
    include: ['tests/e2e/**/*.spec.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 60_000,
  },
})
