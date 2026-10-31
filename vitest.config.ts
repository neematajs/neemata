import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Package projects don't inherit test options from here, so each package
    // config sets its own testTimeout.
    passWithNoTests: true,
    // Proxy tests need a local native build; they run in the proxy workflow.
    projects: [
      './packages/*',
      '!./packages/proxy',
      // Packages without a default config: run them with their named configs.
      '!./packages/nuxt',
      '!./packages/vite',
      './packages/nuxt/vitest.unit.config.ts',
      './packages/nuxt/vitest.e2e.config.ts',
      './packages/vite/vitest.e2e.config.ts',
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
