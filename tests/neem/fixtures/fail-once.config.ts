import { defineConfig, definePlugin, defineRuntime } from '@nmtjs/neem'

export default defineConfig({
  logger: './logger.ts',
  plugins: [
    definePlugin({ name: 'failure-observer', entry: './plugin-hooks.ts' }),
  ],
  runtimes: {
    api: defineRuntime({
      worker: { entry: './fail-once-runtime.ts' },
      threads: [{ label: 'fail-once' }],
    }),
  },
})
