import { fileURLToPath } from 'node:url'

import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    environment: 'node',
    fileParallelism: false,
    include: [
      '../neem/tests/e2e/**/*.spec.ts',
      '../effect/tests/e2e/**/*.spec.ts',
      'tests/e2e/**/*.spec.ts',
    ],
    env: {
      NEEM_E2E_PACKAGE: 'neem-effect',
      NEEM_E2E_BIN: fileURLToPath(
        new URL('./bin/neem-effect.js', import.meta.url),
      ),
    },
    maxWorkers: 1,
    testTimeout: 60_000,
    typecheck: { enabled: true, tsconfig: '../neem/tsconfig.json' },
  },
})
