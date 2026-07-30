import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.spec.ts'],
    typecheck: { enabled: true, tsconfig: './tests/tsconfig.json' },
  },
})
