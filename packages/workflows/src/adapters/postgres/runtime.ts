import type { WorkflowRuntimeAdapter } from '../../runtime/client.ts'
import type { WorkflowRuntimeAtomicStart } from '../../runtime/coordinator.ts'
import type { PruneTerminalRunsParams } from '../../runtime/store.ts'
import type { WorkflowWakeEvents } from '../../runtime/wake-events.ts'
import type {
  WorkflowRuntimeAtomicCompletion,
  WorkflowRuntimeAtomicContinuation,
} from '../../runtime/worker.ts'
import type { WorkflowPostgresConnection } from './connection.ts'
import { SELF_CHILD_KEY } from '../../runtime/child-key.ts'
import { createAttemptExecutor } from './executor.ts'
import { createRunCoordinationExecutor } from './queue.ts'
import { createPostgresWorkflowScheduler } from './schedules.ts'
import { DEFAULT_MAX_DELIVERIES, TASK_RUN_NODE_NAME, one } from './sql.ts'
import {
  createPostgresWorkflowStore,
  createStoredRunWithState,
  pruneTerminalRunsInTransaction,
} from './store.ts'

type PostgresWorkflowRuntime =
  WorkflowRuntimeAdapter<WorkflowPostgresConnection> & {
    readonly connection: WorkflowPostgresConnection
  }

export function createPostgresWorkflowRuntime(params: {
  readonly connection: WorkflowPostgresConnection
  readonly maxDeliveries?: number
  /**
   * Optional LISTEN/NOTIFY wake-up hints (see createPostgresWorkflowWakeEvents).
   * Without it dispatch/cancellation latency is bounded by polling alone.
   */
  readonly wakeEvents?: WorkflowWakeEvents
}): PostgresWorkflowRuntime {
  const db = params.connection
  const ready = Promise.resolve()
  const maxDeliveries = params.maxDeliveries ?? DEFAULT_MAX_DELIVERIES

  const store = createPostgresWorkflowStore({ db, ready })

  const commandContext = { db, ready, maxDeliveries }
  const runCoordinationExecutor = createRunCoordinationExecutor(commandContext)
  const attemptExecutor = createAttemptExecutor(commandContext)

  // A caller-provided connection rides the caller's open transaction:
  // transaction() delegates to the client's own nested-transaction support
  // (or joins the same scope), so the run and its command become visible
  // only when the caller commits.
  const atomicStart: WorkflowRuntimeAtomicStart<WorkflowPostgresConnection> = {
    startWorkflowRun: ({ run, startAt, connection }) =>
      (connection ?? db).transaction(async (tx) => {
        const runtime = createPostgresWorkflowRuntime({ connection: tx })
        const { run: started, created } = await createStoredRunWithState(
          tx,
          run,
        )
        if (!created) return started

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
    startTaskRun: ({
      run,
      taskName,
      taskInput,
      idempotencyKey,
      startAt,
      connection,
    }) =>
      (connection ?? db).transaction(async (tx) => {
        const runtime = createPostgresWorkflowRuntime({ connection: tx })
        const { run: started, created } = await createStoredRunWithState(
          tx,
          run,
        )
        if (!created) return started

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
        await runtime.store.ensureNodeChildren({
          runId: started.id,
          nodeName: TASK_RUN_NODE_NAME,
          children: [{ childKey: SELF_CHILD_KEY, kind: 'task' }],
        })
        const result = await runtime.store.ensureChildAttempt({
          runId: started.id,
          nodeName: TASK_RUN_NODE_NAME,
          childKey: SELF_CHILD_KEY,
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
            childKey: SELF_CHILD_KEY,
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
    ...(params.wakeEvents === undefined
      ? {}
      : {
          wakeEvents: params.wakeEvents,
          dispose: () => params.wakeEvents?.dispose?.(),
        }),
  }
}
