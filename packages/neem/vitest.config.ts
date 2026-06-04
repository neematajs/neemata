import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    typecheck: { enabled: true, tsconfig: './tsconfig.json' },
  },
})
