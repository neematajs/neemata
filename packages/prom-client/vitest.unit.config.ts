import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'prom-client:unit',
    environment: 'node',
    include: ['tests/unit/**/*.spec.js'],
    restoreMocks: true,
    testTimeout: 10_000,
  },
})
