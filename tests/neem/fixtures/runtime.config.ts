import { defineConfig, defineRuntime } from '@nmtjs/neem'

export default defineConfig({
  logger: './logger.ts',
  runtimes: {
    api: defineRuntime({
      entry: './runtime-app.ts',
      threads: [
        {
          label: 'one',
          http: { listen: { hostname: '127.0.0.1', port: 4101 } },
        },
        {
          label: 'two',
          http: { listen: { hostname: '127.0.0.1', port: 4102 } },
        },
      ],
    }),
  },
})
