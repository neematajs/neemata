import { defineNeemataRuntime } from '@nmtjs/application/neem'
import { defineConfig } from '@nmtjs/neem'

export default defineConfig({
  health: {
    hostname: '127.0.0.1',
    port: 3100,
    paths: { health: '/healthz', ready: '/readyz' },
  },
  runtimes: {
    api: defineNeemataRuntime({
      application: './basic-app.ts',
      threads: [{ http: { listen: { hostname: '127.0.0.1', port: 3000 } } }],
    })(),
  },
})
