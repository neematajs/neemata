import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'effect',
    environment: 'node',
    include: ['tests/unit/**/*.spec.ts'],
    testTimeout: 10_000,
  },
})
