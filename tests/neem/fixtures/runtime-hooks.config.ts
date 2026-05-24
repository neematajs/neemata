import { defineConfig, defineRuntimeConfig } from '@nmtjs/neem'

export default defineConfig({
  logger: './logger.ts',
  runtimes: {
    api: defineRuntimeConfig({
      entry: './runtime-app.ts',
      threads: [
        {
          label: 'one',
          http: { listen: { hostname: '127.0.0.1', port: 4111 } },
        },
      ],
    }),
  },
})
