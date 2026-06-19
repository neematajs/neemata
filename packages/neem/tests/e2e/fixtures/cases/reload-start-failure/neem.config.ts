import { defineConfig } from '@nmtjs/neem'

export default defineConfig({
  logger: '../../shared/support/logger.ts',
  health: {
    hostname: '127.0.0.1',
    port: Number.parseInt(
      process.env.NEEM_RELOAD_START_FAILURE_HEALTH_PORT ?? '0',
      10,
    ),
  },
  proxy: {
    hostname: '127.0.0.1',
    port: Number.parseInt(
      process.env.NEEM_RELOAD_START_FAILURE_PROXY_PORT ?? '0',
      10,
    ),
    healthChecks: { interval: 50 },
  },
  runtimes: ['./api.runtime.ts'],
})
