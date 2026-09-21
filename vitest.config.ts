import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    testTimeout: 15000,
    passWithNoTests: true,
    projects: ['./packages/*'],
    coverage: {
      enabled: false,
      include: ['packages/*/src/**'],
      reporter: ['text', 'text-summary', 'html'],
    },
  },
})
