import type { WorkflowRuntimeAdapter } from '../../runtime/client.ts'
import type { WorkflowRuntimeAtomicStart } from '../../runtime/coordinator.ts'
import type { PruneTerminalRunsParams } from '../../runtime/store.ts'
import type {
  WorkflowRuntimeAtomicCompletion,
  WorkflowRuntimeAtomicContinuation,
} from '../../runtime/worker.ts'
import type { WorkflowPostgresConnection } from './connection.ts'
import { createAttemptExecutor } from './executor.ts'
import { createRunCoordinationExecutor } from './queue.ts'
import { createPostgresWorkflowScheduler } from './schedules.ts'
import { DEFAULT_MAX_DELIVERIES, TASK_RUN_NODE_NAME, one } from './sql.ts'
import {
  createPostgresWorkflowStore,
  pruneTerminalRunsInTransaction,
} from './store.ts'

type PostgresWorkflowRuntime = WorkflowRuntimeAdapter & {
  readonly connection: WorkflowPostgresConnection
}

export function createPostgresWorkflowRuntime(params: {
  readonly connection: WorkflowPostgresConnection
  readonly maxDeliveries?: number
}): PostgresWorkflowRuntime {
  const db = params.connection
  const ready = Promise.resolve()
  const maxDeliveries = params.maxDeliveries ?? DEFAULT_MAX_DELIVERIES

  const store = createPostgresWorkflowStore({ db, ready })

  const commandContext = { db, ready, maxDeliveries }
  const runCoordinationExecutor = createRunCoordinationExecutor(commandContext)
  const attemptExecutor = createAttemptExecutor(commandContext)

  const atomicStart: WorkflowRuntimeAtomicStart = {
    startWorkflowRun: ({ run, startAt }) =>
      db.transaction(async (tx) => {
        const runtime = createPostgresWorkflowRuntime({ connection: tx })
        const started = await runtime.store.createRun(run)
        const command = {
          kind: 'continueRun',
          runId: started.id,
          workflowName: started.workflowName,
        } as const
        if (startAt) {
          await runtime.runCoordinationExecutor.enqueueDelayed(command, startAt)
        } else {
          await runtime.runCoordinationExecutor.enqueue(command)
        }
        return started
      }),
    startTaskRun: ({ run, taskName, taskInput, idempotencyKey, startAt }) =>
      db.transaction(async (tx) => {
        const runtime = createPostgresWorkflowRuntime({ connection: tx })
        const started = await runtime.store.createRun(run)
        await runtime.store.createNode({
          runId: started.id,
          name: TASK_RUN_NODE_NAME,
          kind: 'task',
        })
        await runtime.store.setNodeInput({
          runId: started.id,
          nodeName: TASK_RUN_NODE_NAME,
          input: taskInput,
        })
        const result = await runtime.store.ensureNodeAttempt({
          identity: {
            runId: started.id,
            nodeName: TASK_RUN_NODE_NAME,
          },
          kind: 'task',
          input: taskInput,
          ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        })
        await runtime.attemptExecutor.dispatchTask(
          {
            kind: 'taskAttempt',
            workflowName: taskName,
            taskName,
            runId: started.id,
            nodeName: TASK_RUN_NODE_NAME,
            attemptId: result.attempt.id,
            leaseToken: result.attempt.leaseToken!,
            input: result.created ? taskInput : result.attempt.input,
            ...(result.attempt.idempotencyKey === undefined
              ? {}
              : { idempotencyKey: result.attempt.idempotencyKey }),
          },
          startAt === undefined ? undefined : { runAt: startAt },
        )
        return started
      }),
  }

  const atomicCompletion: WorkflowRuntimeAtomicCompletion = {
    run: (handler) =>
      db.transaction(async (tx) => {
        const runtime = createPostgresWorkflowRuntime({ connection: tx })
        return await handler({
          store: runtime.store,
          runCoordinationExecutor: runtime.runCoordinationExecutor,
          attemptExecutor: runtime.attemptExecutor,
        })
      }),
  }

  const atomicContinuation: WorkflowRuntimeAtomicContinuation = {
    run: (handler) =>
      db.transaction(async (tx) => {
        const runtime = createPostgresWorkflowRuntime({ connection: tx })
        return await handler({
          store: runtime.store,
          runCoordinationExecutor: runtime.runCoordinationExecutor,
          attemptExecutor: runtime.attemptExecutor,
        })
      }),
  }

  const retentionPruner = {
    pruneTerminalRuns: (params: PruneTerminalRunsParams) =>
      db.transaction(async (tx) => {
        const lock = await one<{ acquired: boolean }>(
          tx,
          `
            SELECT pg_try_advisory_xact_lock(hashtext('workflow_prune')) AS acquired
          `,
        )
        if (!lock?.acquired) return { deleted: 0 }
        return pruneTerminalRunsInTransaction(tx, params)
      }),
  }

  const scheduler = createPostgresWorkflowScheduler({
    db,
    ready,
    createRuntime: (connection) =>
      createPostgresWorkflowRuntime({ connection, maxDeliveries }),
  })

  return {
    store,
    runCoordinationExecutor,
    attemptExecutor,
    retentionPruner,
    scheduler,
    atomicStart,
    atomicContinuation,
    atomicCompletion,
    connection: db,
  }
}
