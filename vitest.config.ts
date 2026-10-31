import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Package projects don't inherit test options from here, so each package
    // config sets its own testTimeout.
    passWithNoTests: true,
    // One project per package and tier, named `<package>:<tier>`. Proxy tests
    // need a local native build; they run in the proxy workflow.
    projects: [
      './packages/*/vitest.{unit,integration,e2e}.config.ts',
      '!./packages/proxy/**',
    ],
    coverage: {
      enabled: false,
      // Vitest 5 matches coverage paths relative to the project root, which is
      // the package directory when a single project is selected via --project.
      include: ['packages/*/src/**', 'src/**'],
      reporter: ['text', 'text-summary', 'html'],
    },
  },
})
