import type { WorkflowStore } from '../../runtime/store.ts'
import type { WorkflowPostgresConnection } from './connection.ts'
import { createPostgresWorkflowChildStore } from './store-children.ts'
import { createPostgresWorkflowNodeStore } from './store-nodes.ts'
import {
  createPostgresWorkflowRunStore,
  createStoredRun,
} from './store-runs.ts'

export {
  createStoredRun,
  createStoredRunWithState,
  pruneTerminalRunsInTransaction,
} from './store-runs.ts'

type PostgresWorkflowStoreContext = {
  readonly db: WorkflowPostgresConnection
  readonly ready: Promise<void>
}

export const createPostgresWorkflowStore = (
  ctx: PostgresWorkflowStoreContext,
): WorkflowStore => {
  const { db, ready } = ctx

  return {
    ...createPostgresWorkflowRunStore({ db, ready }),
    ...createPostgresWorkflowNodeStore({ db, ready }),
    ...createPostgresWorkflowChildStore({ db, ready, createStoredRun }),
  }
}
