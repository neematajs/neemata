import { defineConfig, definePlugin } from '@nmtjs/neem'

export default defineConfig({
  logger: '../../shared/support/logger.ts',
  plugins: [
    definePlugin({
      name: 'fixture-plugin',
      entry: '../../shared/support/plugin-hooks.ts',
      options: { fixture: 'plugin' },
    }),
  ],
  runtimes: ['./api.runtime.ts'],
})
