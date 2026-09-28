import { createWorkflowsRuntime } from '@nmtjs/workflows/neem'

export default createWorkflowsRuntime()({
  name: 'workflows',
  planner: './workflows.planner.ts',
  worker: { entry: './workflows.worker.ts' },
})
