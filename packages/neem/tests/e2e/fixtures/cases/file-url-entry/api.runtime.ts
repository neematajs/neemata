import { defineRuntime } from '@nmtjs/neem'

export default defineRuntime({
  name: 'file-url-entry',
  planner: new URL('./api.planner.ts', import.meta.url),
  worker: { entry: new URL('./api.worker.ts', import.meta.url) },
  host: { entry: new URL('./api.host.ts', import.meta.url) },
})
