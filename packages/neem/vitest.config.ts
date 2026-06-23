import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.spec.ts', 'tests/integration/**/*.spec.ts'],
    typecheck: { enabled: true, tsconfig: './tsconfig.json' },
  },
})
