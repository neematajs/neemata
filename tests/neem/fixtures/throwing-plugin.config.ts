import { defineConfig, definePlugin, defineRuntime } from '@nmtjs/neem'

export default defineConfig({
  logger: './logger.ts',
  plugins: [
    definePlugin({
      name: 'throwing-plugin',
      entry: './throwing-plugin-hooks.ts',
    }),
  ],
  runtimes: {
    api: defineRuntime({
      worker: { entry: './generic-runtime.ts' },
      threads: [{ label: 'plugin-hook-failure' }],
    }),
  },
})
