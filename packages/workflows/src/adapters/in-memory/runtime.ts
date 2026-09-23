import type {
  ActivityAttemptCommand,
  ContinueRunCommand,
  TaskAttemptCommand,
} from '../../runtime/commands.ts'
import type { WorkflowRuntimeAtomicStart } from '../../runtime/coordinator.ts'
import type {
  AttemptExecutor,
  RunCoordinationExecutor,
} from '../../runtime/executors.ts'
import type {
  StoredWorkflowSchedule,
  WorkflowScheduler,
} from '../../runtime/scheduler.ts'
import type {
  StoredAttempt,
  StoredNode,
  StoredNodeChild,
  StoredRun,
} from '../../runtime/state.ts'
import type {
  WorkflowRetentionPruner,
  WorkflowStore,
} from '../../runtime/store.ts'
import type { WorkflowWakeEvents } from '../../runtime/wake-events.ts'
import type { InspectQueueItem, QueueItem } from './commands.ts'
import { dispatchTaskRunAttempt } from '../../runtime/coordinator/attempt.ts'
import { inspectQueueItem } from './commands.ts'
import { createAttemptExecutor } from './executor.ts'
import { createRunCoordinationExecutor } from './queue.ts'
import { createScheduler } from './schedules.ts'
import { createState } from './state.ts'
import { createRunWithState } from './store-runs.ts'
import { createStore } from './store.ts'

export type InMemoryWorkflowRuntime = {
  readonly store: WorkflowStore
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly attemptExecutor: AttemptExecutor
  readonly retentionPruner: WorkflowRetentionPruner
  readonly scheduler: WorkflowScheduler
  readonly atomicStart: WorkflowRuntimeAtomicStart
  readonly inspect: () => {
    readonly runs: readonly StoredRun[]
    readonly nodes: readonly StoredNode[]
    readonly children: readonly StoredNodeChild[]
    readonly attempts: readonly StoredAttempt[]
    readonly continueRunCommands: readonly InspectQueueItem<ContinueRunCommand>[]
    readonly activityCommands: readonly InspectQueueItem<ActivityAttemptCommand>[]
    readonly taskCommands: readonly InspectQueueItem<TaskAttemptCommand>[]
    readonly schedules: readonly StoredWorkflowSchedule[]
  }
  readonly wakeEvents: WorkflowWakeEvents
}

export function createInMemoryWorkflowRuntime(
  options: { readonly maxDeliveries?: number } = {},
): InMemoryWorkflowRuntime {
  // Each adapter owns its context; only this instance's components share it.
  const state = createState(options.maxDeliveries)
  const store = createStore(state)
  const runCoordinationExecutor = createRunCoordinationExecutor(state)
  const attemptExecutor = createAttemptExecutor(state)
  const scheduler = createScheduler(state, {
    store,
    runCoordinationExecutor,
    attemptExecutor,
  })

  // Caller-provided connections are ignored: there is no transaction to join
  // in-process, and rejecting them would break postgres-facing code paths
  // running against this runtime as a drop-in test double.
  const atomicStart: WorkflowRuntimeAtomicStart = {
    async startWorkflowRun({ run, startAt }) {
      const started = createRunWithState(state, run)
      if (!started.created) return started.run

      const command = {
        kind: 'continueRun',
        runId: started.run.id,
        workflowName: started.run.workflowName,
      } as const
      if (startAt) {
        await runCoordinationExecutor.enqueueDelayed(command, startAt)
      } else {
        await runCoordinationExecutor.enqueue(command)
      }
      return started.run
    },
    async startTaskRun({ run, taskName, taskInput, idempotencyKey, startAt }) {
      const started = createRunWithState(state, run)
      if (!started.created) return started.run

      await dispatchTaskRunAttempt({
        store,
        runCoordinationExecutor,
        attemptExecutor,
        taskName,
        taskRunId: started.run.id,
        taskInput,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        startAt,
        throwOnDispatchFailure: true,
      })
      return started.run
    },
  }

  function inspect(): ReturnType<InMemoryWorkflowRuntime['inspect']> {
    const {
      runs,
      nodes,
      children,
      attempts,
      continueRunCommands,
      attemptCommands,
      schedules,
    } = state
    return {
      runs: [...runs.values()],
      nodes: [...nodes.values()],
      children: [...children.values()],
      attempts: [...attempts.values()],
      continueRunCommands: continueRunCommands.map(inspectQueueItem),
      activityCommands: attemptCommands
        .filter(
          (item): item is QueueItem<ActivityAttemptCommand> =>
            item.payload.kind === 'activityAttempt',
        )
        .map(inspectQueueItem),
      taskCommands: attemptCommands
        .filter(
          (item): item is QueueItem<TaskAttemptCommand> =>
            item.payload.kind === 'taskAttempt',
        )
        .map(inspectQueueItem),
      schedules: [...schedules.values()],
    }
  }

  return {
    store,
    retentionPruner: store,
    runCoordinationExecutor,
    attemptExecutor,
    atomicStart,
    scheduler,
    inspect,
    wakeEvents: state.wake.events,
  }
}
