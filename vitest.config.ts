import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    testTimeout: 15000,
    passWithNoTests: true,
    // Proxy tests need a local native build; they run in the proxy workflow.
    projects: ['./packages/*', '!./packages/proxy'],
    coverage: {
      enabled: false,
      include: ['packages/*/src/**'],
      reporter: ['text', 'text-summary', 'html'],
    },
  },
})
