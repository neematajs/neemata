import type { ViteUserConfig } from 'vitest/config'

// Measurements need one file at a time in a fresh fork, and a benchmark file
// may legitimately run for half an hour under that.
const TIMEOUT = 30 * 60 * 1_000

export const benchBase = {
  environment: 'node',
  fileParallelism: false,
  hookTimeout: TIMEOUT,
  isolate: true,
  maxWorkers: 1,
  pool: 'forks',
  testTimeout: TIMEOUT,
  benchmark: {
    enabled: true,
    includeSamples: true,
    reporters: ['default'],
  },
} satisfies ViteUserConfig['test']
