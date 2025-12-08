import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    testTimeout: 15000,
    passWithNoTests: true,
    projects: ['./packages/*', './tests/test/integration'],
    coverage: {
      enabled: false,
      include: ['packages/*/src/**'],
      exclude: [
        'packages/runtime/**',
        'packages/nmtjs/**',
        'packages/proxy/**',
      ],
      reporter: ['text', 'text-summary', 'html'],
    },
  },
})
