import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    environment: 'node',
    fileParallelism: false,
    include: ['tests/e2e/**/*.spec.ts'],
    maxWorkers: 1,
    typecheck: { enabled: true, tsconfig: './tsconfig.json' },
  },
})
