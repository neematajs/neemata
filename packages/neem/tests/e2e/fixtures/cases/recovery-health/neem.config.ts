import { defineConfig } from '@nmtjs/neem'

export default defineConfig({
  logger: '../../shared/support/logger.ts',
  health: {
    hostname: '127.0.0.1',
    port: Number.parseInt(process.env.NEEM_HEALTH_PORT ?? '0', 10),
    paths: { health: '/health', ready: '/ready' },
  },
  runtimes: ['./api.runtime.ts'],
})
