import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'metrics:integration',
    environment: 'node',
    include: ['tests/integration/**/*.spec.ts'],
    testTimeout: 30_000,
  },
})
