import type { WorkflowStore } from '../../runtime/store.ts'
import type { WorkflowPostgresConnection } from './connection.ts'
import { createPostgresWorkflowChildStore } from './store-children.ts'
import { createPostgresWorkflowNodeStore } from './store-nodes.ts'
import { reopenFailedRun } from './store-retry.ts'
import { createPostgresWorkflowRunStore } from './store-runs.ts'

type PostgresWorkflowStoreContext = {
  readonly db: WorkflowPostgresConnection
  readonly maxDeliveries: number
}

export const createPostgresWorkflowStore = ({
  db,
  maxDeliveries,
}: PostgresWorkflowStoreContext): WorkflowStore => ({
  reopenFailedRun: (params) => reopenFailedRun(db, params, maxDeliveries),
  ...createPostgresWorkflowRunStore(db),
  ...createPostgresWorkflowNodeStore(db),
  ...createPostgresWorkflowChildStore(db),
})
