import { fileURLToPath } from 'node:url'

import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    environment: 'node',
    fileParallelism: false,
    include: ['../neem/tests/stress/**/*.spec.ts'],
    env: {
      NEEM_E2E_BIN: fileURLToPath(
        new URL('./bin/neem-effect.js', import.meta.url),
      ),
    },
    maxWorkers: 1,
    testTimeout: 120_000,
  },
})
