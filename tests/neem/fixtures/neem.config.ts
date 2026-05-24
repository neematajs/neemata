import { defineNeemataRuntime } from '@nmtjs/application/neem'
import { defineConfig } from '@nmtjs/neem'

export default defineConfig({
  logger: () => import('./logger.ts'),
  runtimes: {
    api: defineNeemataRuntime({
      entry: () => import('./basic-app.ts'),
      build: () => import('./basic-app.build.ts'),
      threads: [{ http: { listen: { hostname: '127.0.0.1', port: 3000 } } }],
    }),
  },
})
