import { defineMetricsPlugin } from '@nmtjs/metrics/neem'
import { defineConfig } from '@nmtjs/neem'

export default defineConfig({
  logger: '../../shared/support/logger.ts',
  plugins: [
    defineMetricsPlugin({
      server: {
        host: '127.0.0.1',
        port: Number.parseInt(process.env.NEEM_METRICS_PORT ?? '0', 10),
        path: '/metrics',
      },
    }),
  ],
  runtimes: ['./api.runtime.ts'],
})
