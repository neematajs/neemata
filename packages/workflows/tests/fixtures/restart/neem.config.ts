import { defineConfig } from '@nmtjs/neem'

export default defineConfig({
  runtimes: ['./workflows.runtime.ts'],
  // The test edits a worker right after a build; native watching on macOS
  // can drop an edit that lands in that window, polling cannot.
  build: { watch: { usePolling: true, pollInterval: 50 } },
})
