import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    exclude: ['tests/**/*.browser.spec.ts', 'tests/_legacy/**'],
    typecheck: { enabled: true, tsconfig: './tsconfig.json' },
  },
})
