import { defineAppConfig, defineConfig, definePluginConfig } from '@nmtjs/neem'

export default defineConfig({
  apps: {
    api: defineAppConfig({
      entry: () => import('./lazy.app.ts'),
      build: () => import('./lazy.build.ts'),
      threads: [{ http: { listen: { hostname: '127.0.0.1', port: 3001 } } }],
    }),
  },
  plugins: [
    definePluginConfig({
      entry: () => import('./lazy.plugin.ts'),
      options: { queue: 'lazy' },
    }),
  ],
})
