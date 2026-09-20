import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    environment: 'node',
    fileParallelism: false,
    maxWorkers: 1,
    include: ['tests/e2e/**/*.spec.ts'],
    testTimeout: 60_000,
  },
})
