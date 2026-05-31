import { defineConfig, definePlugin, defineRuntime } from '@nmtjs/neem'

export default defineConfig({
  logger: './logger.ts',
  plugins: [
    definePlugin({
      name: 'fixture-plugin',
      entry: './plugin-hooks.ts',
      options: { fixture: 'plugin' },
    }),
  ],
  runtimes: {
    api: defineRuntime({
      worker: { entry: './generic-runtime.ts' },
      threads: [{ label: 'plugin' }],
    }),
  },
})
