import { defineConfig, definePlugin } from '@nmtjs/neem'

export default defineConfig({
  logger: '../../shared/support/logger.ts',
  plugins: [
    definePlugin({
      name: 'throwing-plugin',
      entry: '../../shared/support/throwing-plugin-hooks.ts',
    }),
  ],
  runtimes: ['./api.runtime.ts'],
})
