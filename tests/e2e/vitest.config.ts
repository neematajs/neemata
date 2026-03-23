import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    exclude: ['tests/jobs*.spec.ts'],
    testTimeout: 10000,
    fileParallelism: false,
    maxConcurrency: 1,
  },
})
