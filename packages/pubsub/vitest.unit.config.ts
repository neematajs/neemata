import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'pubsub:unit',
    environment: 'node',
    include: ['tests/unit/**/*.spec.ts'],
    testTimeout: 10_000,
  },
})
