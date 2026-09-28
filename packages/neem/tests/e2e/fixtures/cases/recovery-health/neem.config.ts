import { defineConfig } from '@nmtjs/neem'

export default defineConfig({
  logger: '../../shared/support/logger.ts',
  server: { hostname: '127.0.0.1' },
  runtimes: ['./api.runtime.ts'],
})
