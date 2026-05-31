import { defineConfig, defineRuntime } from '@nmtjs/neem'

export default defineConfig({
  logger: './logger.ts',
  runtimes: {
    api: defineRuntime({
      worker: { entry: './generic-runtime.ts' },
      threads: [
        {
          label: 'one',
          http: { listen: { hostname: '127.0.0.1', port: 4201 } },
        },
        {
          label: 'two',
          http: { listen: { hostname: '127.0.0.1', port: 4202 } },
        },
      ],
    }),
    jobs: defineRuntime({
      worker: { entry: './generic-runtime.ts' },
      host: { entry: './generic-runtime-host.ts' },
      options: { queue: 'runtime' },
    }),
  },
})
