import { defineConfig, definePlugin } from '@nmtjs/neem'

export default defineConfig({
  logger: '../../shared/support/logger.ts',
  plugins: [
    definePlugin({
      name: 'host-failure-observer',
      entry: '../../shared/support/plugin-hooks.ts',
    }),
  ],
  runtimes: ['./scheduler.runtime.ts'],
})
