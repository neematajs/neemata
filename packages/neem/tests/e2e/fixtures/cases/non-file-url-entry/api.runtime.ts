import { defineRuntime } from '@nmtjs/neem'

export default defineRuntime({
  name: 'non-file-url-entry',
  planner: './api.planner.ts',
  worker: { entry: new URL('https://example.test/neem-worker.js') },
})
