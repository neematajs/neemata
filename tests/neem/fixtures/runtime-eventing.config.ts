import { defineEventingRuntime } from '@nmtjs/eventing/neem'
import { defineConfig } from '@nmtjs/neem'

export default defineConfig({
  runtimes: {
    events: defineEventingRuntime({
      config: './runtime-eventing.ts',
      threads: 2,
    }),
  },
})
