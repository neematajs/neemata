import { defineConfig } from '@nmtjs/neem'

export default defineConfig({
  build: { experimentalDev: true },
  runtimes: ['./api.runtime.ts'],
})
