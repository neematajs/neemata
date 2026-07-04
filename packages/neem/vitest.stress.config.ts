import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    environment: 'node',
    fileParallelism: false,
    include: ['tests/stress/**/*.spec.ts'],
    maxWorkers: 1,
    testTimeout: 120_000,
    typecheck: { enabled: true, tsconfig: './tsconfig.json' },
  },
})
