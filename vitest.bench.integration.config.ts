import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    isolate: true,
    maxWorkers: 1,
    testTimeout: 180_000,
    benchmark: {
      enabled: true,
      include: ['packages/*/bench/**/*.integration.bench.ts'],
      includeSamples: true,
      reporters: ['default'],
    },
  },
})
