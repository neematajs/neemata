import { defineConfig, definePlugin } from '@nmtjs/neem'

export default defineConfig({
  plugins: [definePlugin({ name: 'ready', entry: './ready.plugin.ts' })],
  runtimes: ['./workflows.runtime.ts'],
})
