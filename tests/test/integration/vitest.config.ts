import { defineProject } from 'vitest/config'

export default defineProject({
  test: { environment: 'node', include: ['./suites/**/*.spec.ts'] },
})
