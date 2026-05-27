import { defineConfig, defineRuntime } from '@nmtjs/neem'

export default defineConfig({
  runtimes: {
    api: defineRuntime({
      entry: './runtime-app.ts',
      threads: [
        {
          label: 'ready-before-failure',
          http: { listen: { hostname: '127.0.0.1', port: 4201 } },
        },
        {
          label: 'fails-on-start',
          fail: 'start',
          startDelayMs: 25,
          http: { listen: { hostname: '127.0.0.1', port: 4202 } },
        },
      ],
    })(),
  },
})
