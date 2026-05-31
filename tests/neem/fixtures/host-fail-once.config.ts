import { defineConfig, definePlugin, defineRuntime } from '@nmtjs/neem'

export default defineConfig({
  logger: './logger.ts',
  plugins: [
    definePlugin({ name: 'host-failure-observer', entry: './plugin-hooks.ts' }),
  ],
  runtimes: {
    scheduler: defineRuntime({
      host: { entry: './host-fail-once.host.ts' },
      threads: 0,
    }),
  },
})
