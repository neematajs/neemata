import { defineAppConfig, defineConfig, definePluginConfig } from '@nmtjs/neem'

export default defineConfig({
  apps: {
    api: defineAppConfig({
      entry: () => import('./runtime-app.ts'),
      threads: [
        {
          label: 'one',
          http: { listen: { hostname: '127.0.0.1', port: 4101 } },
        },
        {
          label: 'two',
          http: { listen: { hostname: '127.0.0.1', port: 4102 } },
        },
      ],
    }),
  },
  plugins: [
    definePluginConfig({
      entry: () => import('./jobs.plugin.ts'),
      options: { queue: 'runtime' },
    }),
  ],
})
