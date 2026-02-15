import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    exclude: ['test/jobs.spec.ts'],
    testTimeout: 30000,
    fileParallelism: false,
    maxConcurrency: 1,
  },
})
