import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'neem:stress',
    environment: 'node',
    fileParallelism: false,
    include: ['tests/stress/**/*.spec.ts'],
    maxWorkers: 1,
    testTimeout: 120_000,
  },
})
