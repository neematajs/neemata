import { defineConfig, definePlugin } from '@nmtjs/neem'

export default defineConfig({
  logger: '../../shared/support/logger.ts',
  plugins: [
    definePlugin({
      name: 'failure-observer',
      entry: '../../shared/support/plugin-hooks.ts',
    }),
  ],
  runtimes: ['./api.runtime.ts'],
})
