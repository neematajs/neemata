import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    environment: 'node',
    include: ['test/**/*.spec.ts'],
    testTimeout: 10_000,
  },
})
