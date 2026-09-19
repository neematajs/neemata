import { defineConfig } from 'vitest/config'

import { benchBase } from './vitest.bench.base.ts'

export default defineConfig({
  test: {
    ...benchBase,
    benchmark: {
      ...benchBase.benchmark,
      exclude: ['**/*.integration.bench.ts'],
      include: ['packages/*/bench/**/*.bench.ts'],
    },
  },
})
