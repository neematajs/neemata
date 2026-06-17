import { defineRuntime } from '@nmtjs/neem'

export default defineRuntime({
  name: 'api',
  worker: { entry: '../../shared/workers/generic-runtime.ts' },
})
