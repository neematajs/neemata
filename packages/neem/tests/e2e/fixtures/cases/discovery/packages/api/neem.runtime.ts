import { defineRuntime } from '../../neem.ts'

export default defineRuntime({
  worker: { entry: '../../../../shared/workers/runtime-app.ts' },
})
