import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    testTimeout: 15000,
    passWithNoTests: true,
    projects: ['./packages/*', '!./packages/eventing'],
    coverage: {
      enabled: false,
      include: ['packages/*/src/**'],
      exclude: ['packages/eventing/**', 'packages/nmtjs/**'],
      reporter: ['text', 'text-summary', 'html'],
    },
  },
})
