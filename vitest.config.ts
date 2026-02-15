import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    testTimeout: 15000,
    passWithNoTests: true,
    projects: ['./packages/*', './tests/integration', './tests/e2e'],
    coverage: {
      enabled: false,
      include: ['packages/*/src/**'],
      exclude: ['packages/nmtjs/**', 'packages/proxy/**'],
      reporter: ['text', 'text-summary', 'html'],
    },
  },
})
