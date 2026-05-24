import { defineConfig, defineRuntimeConfig } from '@nmtjs/neem'

export default defineConfig({
  runtimes: {
    api: defineRuntimeConfig({
      entry: './lazy.app.ts',
      build: './lazy.build.ts',
      threads: [{ http: { listen: { hostname: '127.0.0.1', port: 3001 } } }],
    }),
  },
})
