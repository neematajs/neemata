import { createWorkflowsRuntime } from '@nmtjs/workflows/neem'

export default createWorkflowsRuntime()({
  name: 'workflows',
  planner: './app.planner.ts',
  worker: { entry: './app.worker.ts' },
})
