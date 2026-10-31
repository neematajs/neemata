import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'nuxt:e2e',
    environment: 'node',
    fileParallelism: false,
    hookTimeout: 45_000,
    include: ['tests/e2e/**/*.spec.ts'],
    maxWorkers: 1,
    testTimeout: 60_000,
  },
})
