import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    testTimeout: 15000,
    passWithNoTests: true,
    // Proxy tests need a local native build; they run in the proxy workflow.
    projects: ['./packages/*', '!./packages/proxy'],
    coverage: {
      enabled: false,
      // Vitest 5 matches coverage paths relative to the project root, which is
      // the package directory when a single project is selected via --project.
      include: ['packages/*/src/**', 'src/**'],
      reporter: ['text', 'text-summary', 'html'],
    },
  },
})
