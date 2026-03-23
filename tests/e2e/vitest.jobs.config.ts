import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/jobs*.spec.ts'],
    testTimeout: 10000,
    fileParallelism: false,
  },
})
