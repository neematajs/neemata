import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    hookTimeout: 30 * 60 * 1_000,
    isolate: true,
    maxWorkers: 1,
    pool: 'forks',
    testTimeout: 30 * 60 * 1_000,
    benchmark: {
      enabled: true,
      include: ['packages/*/bench/**/*.integration.bench.ts'],
      includeSamples: true,
      reporters: ['default'],
    },
  },
})
