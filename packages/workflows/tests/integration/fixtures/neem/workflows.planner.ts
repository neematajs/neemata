import type { WorkflowsPlan } from '@nmtjs/workflows/neem'
import { defineWorkflowsPlanner } from '@nmtjs/workflows/neem'

// One build serves every layout a test asks for when it starts.
export default defineWorkflowsPlanner(
  (): WorkflowsPlan => JSON.parse(process.env.WORKFLOWS_PLAN!),
)
