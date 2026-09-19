import { defineConfig } from 'vitest/config'

import { benchBase } from './vitest.bench.base.ts'

export default defineConfig({
  test: {
    ...benchBase,
    benchmark: {
      ...benchBase.benchmark,
      include: ['packages/*/bench/**/*.integration.bench.ts'],
    },
  },
})
