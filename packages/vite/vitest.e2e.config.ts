import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'vite:e2e',
    environment: 'node',
    include: ['tests/e2e/**/*.spec.ts'],
    fileParallelism: false,
    hookTimeout: 45_000,
    maxWorkers: 1,
    testTimeout: 60_000,
  },
})
