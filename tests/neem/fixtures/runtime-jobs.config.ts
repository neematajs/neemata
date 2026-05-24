import { defineConfig, definePluginConfig } from '@nmtjs/neem'

export default defineConfig({
  apps: {},
  plugins: [
    definePluginConfig({ entry: () => import('./runtime-jobs.plugin.ts') }),
  ],
})
