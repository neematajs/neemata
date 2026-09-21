import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    typecheck: { enabled: true, tsconfig: './tsconfig.json' },
  },
})
