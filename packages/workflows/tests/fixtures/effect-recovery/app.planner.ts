import { defineWorkflowsPlanner } from '@nmtjs/workflows/neem'

import { config } from './config.ts'

export default defineWorkflowsPlanner(() => config)
