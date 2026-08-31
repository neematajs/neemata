import { defineConfig } from '@nmtjs/neem'

export default defineConfig({
  build: { experimentalDev: true },
  runtimes: ['./workflows.runtime.ts'],
})
