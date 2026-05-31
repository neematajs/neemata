import { defineConfig, defineRuntime } from '@nmtjs/neem'

export default defineConfig({
  logger: './logger.ts',
  runtimes: {
    scheduler: defineRuntime({
      host: { entry: './host-only.host.ts' },
      threads: 0,
      options: { fixture: 'host-only' },
    }),
  },
})
