import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'workflows:unit',
    environment: 'node',
    include: ['tests/unit/**/*.spec.ts'],
    testTimeout: 10_000,
  },
})
