import { defineConfig } from '@nmtjs/neem'

export default defineConfig({
  runtimes: ['./neem.runtime.ts', './admin/neem.runtime.ts'],
  proxy: { hostname: '127.0.0.1', port: 8790 },
})
