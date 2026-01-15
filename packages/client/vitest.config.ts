import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    environment: 'node',
    include: ['test/**/*.spec.ts'],
    exclude: ['test/_legacy/**'],
    typecheck: { enabled: true, tsconfig: './tsconfig.json' },
  },
})
