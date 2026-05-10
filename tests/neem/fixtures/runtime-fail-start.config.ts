import { defineAppConfig, defineConfig } from '@nmtjs/neem'

export default defineConfig({
  apps: {
    api: defineAppConfig({
      entry: () => import('./runtime-app.ts'),
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
    }),
  },
})
