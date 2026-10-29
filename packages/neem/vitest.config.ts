import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    environment: 'node',
    include: [
      'tests/unit/**/*.spec.ts',
      'tests/integration/**/*.spec.ts',
      'tests/regression/**/*.spec.ts',
    ],
    testTimeout: 10_000,
  },
})
