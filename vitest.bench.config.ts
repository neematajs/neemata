import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    isolate: true,
    maxWorkers: 1,
    benchmark: {
      enabled: true,
      exclude: ['**/*.integration.bench.ts'],
      include: ['packages/*/bench/**/*.bench.ts'],
      includeSamples: true,
      reporters: ['default'],
    },
  },
})
