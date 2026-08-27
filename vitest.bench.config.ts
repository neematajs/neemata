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
      exclude: ['**/*.integration.bench.ts'],
      include: ['packages/*/bench/**/*.bench.ts'],
      includeSamples: true,
      reporters: ['default'],
    },
  },
})
