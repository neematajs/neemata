import { defineConfig } from '@nmtjs/neem'

export default defineConfig({
  runtimes: ['./web/neem.runtime.ts', './admin/neem.runtime.ts'],
  proxy: { hostname: '127.0.0.1', port: 8791 },
})
