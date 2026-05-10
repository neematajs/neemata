import { defineAppConfig, defineConfig } from '@nmtjs/neem'

export default defineConfig({
  apps: {
    api: defineAppConfig({
      entry: () => import('./runtime-app.ts'),
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
