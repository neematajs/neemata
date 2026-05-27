import { defineConfig, defineRuntime } from '@nmtjs/neem'

export default defineConfig({
  runtimes: {
    api: defineRuntime({
      entry: './lazy.app.ts',
      build: './lazy.build.ts',
      threads: [{ http: { listen: { hostname: '127.0.0.1', port: 3001 } } }],
    })(),
  },
})
