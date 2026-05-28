import { defineConfig, defineRuntime } from '@nmtjs/neem'

export default defineConfig({
  runtimes: {
    api: [
      defineRuntime({
        worker: { entry: './lazy.app.ts' },
        threads: [{ http: { listen: { hostname: '127.0.0.1', port: 3001 } } }],
      }),
      {
        worker: {
          build: { rolldown: { external: ['lazy-runtime-external'] } },
        },
      },
    ],
  },
})
