import { defineConfig, defineRuntime } from '@nmtjs/neem'

export default defineConfig({
  logger: './logger.ts',
  proxy: {
    hostname: '127.0.0.1',
    port: Number.parseInt(process.env.NEEM_PROXY_PORT ?? '0', 10),
    healthChecks: { interval: 50 },
    runtimes: {
      api: { routing: { type: 'path', name: 'api', default: true } },
    },
  },
  runtimes: {
    api: defineRuntime({
      worker: { entry: './http-runtime.ts' },
      threads: [
        {
          label: 'api',
          port: Number.parseInt(
            process.env.NEEM_PROXY_UPSTREAM_PORT ?? '0',
            10,
          ),
        },
      ],
    }),
  },
})
