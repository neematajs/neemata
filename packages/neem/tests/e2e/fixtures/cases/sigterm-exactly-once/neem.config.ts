import { defineConfig, definePlugin } from '@nmtjs/neem'

export default defineConfig({
  logger: '../../shared/support/logger.ts',
  plugins: [
    definePlugin({ name: 'sigterm-plugin', entry: './plugin-hooks.ts' }),
  ],
  runtimes: ['./api.runtime.ts'],
})
