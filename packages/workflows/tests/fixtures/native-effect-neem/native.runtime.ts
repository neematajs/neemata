import { createNativeWorkflowsRuntime } from '@nmtjs/workflows/native-effect/neem'

export default createNativeWorkflowsRuntime({
  name: 'native-workflows',
  planner: './native.planner.ts',
  worker: { entry: './native.worker.ts' },
})
