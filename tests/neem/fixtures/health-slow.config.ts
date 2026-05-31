import { defineConfig, defineRuntime } from '@nmtjs/neem'

export default defineConfig({
  logger: './logger.ts',
  health: {
    hostname: '127.0.0.1',
    port: Number.parseInt(process.env.NEEM_HEALTH_PORT ?? '0', 10),
    paths: { health: '/healthz', ready: '/readyz' },
  },
  runtimes: {
    api: defineRuntime({
      worker: { entry: './runtime-app.ts' },
      threads: [{ label: 'slow', startDelayMs: 2_000 }],
    }),
  },
})
