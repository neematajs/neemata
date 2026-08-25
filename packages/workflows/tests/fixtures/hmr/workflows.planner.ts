import { defineWorkflowsPlanner } from '@nmtjs/workflows/neem'

import workers from './workflow-workers.ts'

export default defineWorkflowsPlanner(() => workers)
