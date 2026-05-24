import { defineConfig, defineRuntimeConfig } from '@nmtjs/neem'

export default defineConfig({
  logger: () => import('./logger.ts'),
  runtimes: {
    api: defineRuntimeConfig({
      entry: () => import('./runtime-app.ts'),
      threads: [
        {
          label: 'one',
          http: { listen: { hostname: '127.0.0.1', port: 4111 } },
        },
      ],
    }),
  },
})
