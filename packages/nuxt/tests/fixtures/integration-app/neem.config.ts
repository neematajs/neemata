import { defineConfig } from '@nmtjs/neem'

// The port comes from the spawning test so parallel runs never collide.
export default defineConfig({
  runtimes: ['./web/neem.runtime.ts', './admin/neem.runtime.ts'],
  proxy: { hostname: '127.0.0.1', port: Number(process.env.NEEM_TEST_PORT) },
})
