import { defineConfig, defineRuntime } from '@nmtjs/neem'

export default defineConfig({
  runtimes: { api: defineRuntime({ entry: './runtime-bootstrap-fail.ts' }) },
})
