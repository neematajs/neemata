import { defineAppConfig, defineConfig, definePluginConfig } from '@nmtjs/neem'

export default defineConfig({
  apps: {
    api: defineAppConfig({
      entry: () => import('./basic-app.ts'),
      build: () => import('./basic-app.build.ts'),
      threads: [{ http: { listen: { hostname: '127.0.0.1', port: 3000 } } }],
    }),
  },
  plugins: [
    definePluginConfig({
      entry: () => import('./jobs.plugin.ts'),
      options: { queue: 'a', concurrency: 2 },
    }),
  ],
})
