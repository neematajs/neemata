import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'prom-client:integration',
    environment: 'node',
    include: ['tests/integration/**/*.spec.js'],
    restoreMocks: true,
    testTimeout: 30_000,
  },
})
