import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    environment: 'node',
    fileParallelism: false,
    hookTimeout: 45_000,
    include: ['tests/e2e/**/*.spec.ts'],
    maxWorkers: 1,
    typecheck: { enabled: true, tsconfig: './tests/tsconfig.json' },
  },
})
