import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'pubsub:integration',
    environment: 'node',
    include: ['tests/integration/**/*.spec.ts'],
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
})
