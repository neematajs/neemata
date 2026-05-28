import { defineConfig, defineRuntime } from '@nmtjs/neem'

export default defineConfig({
  runtimes: {
    api: defineRuntime({
      worker: { entry: './runtime-app.ts' },
      threads: [
        {
          label: 'survives-until-peer-fails',
          http: { listen: { hostname: '127.0.0.1', port: 4301 } },
        },
        {
          label: 'fails-after-start',
          fail: 'runtime',
          runtimeFailDelayMs: 25,
          http: { listen: { hostname: '127.0.0.1', port: 4302 } },
        },
      ],
    }),
  },
})
