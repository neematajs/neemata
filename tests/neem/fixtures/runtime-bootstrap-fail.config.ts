import { defineConfig, defineRuntime } from '@nmtjs/neem'

export default defineConfig({
  runtimes: {
    api: defineRuntime({ worker: { entry: './runtime-bootstrap-fail.ts' } }),
  },
})
