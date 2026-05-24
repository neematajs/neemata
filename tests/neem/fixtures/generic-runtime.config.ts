import { defineConfig, defineRuntimeConfig } from '@nmtjs/neem'

export default defineConfig({
  logger: () => import('./logger.ts'),
  runtimes: {
    api: defineRuntimeConfig({
      entry: () => import('./generic-runtime.ts'),
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
    jobs: defineRuntimeConfig({
      entry: () => import('./generic-runtime.ts'),
      host: { entry: () => import('./generic-runtime-host.ts') },
      options: { queue: 'runtime' },
    }),
  },
})
