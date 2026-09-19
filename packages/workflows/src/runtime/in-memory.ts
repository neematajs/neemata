import type {
  ActivityAttemptCommand,
  ContinueRunCommand,
  TaskAttemptCommand,
} from './commands.ts'
import type { WorkflowRuntimeAtomicStart } from './coordinator/start.ts'
import type { AttemptExecutor, RunCoordinationExecutor } from './executors.ts'
import type { InspectQueueItem, QueueItem } from './in-memory/state.ts'
import type { StoredWorkflowSchedule, WorkflowScheduler } from './scheduler.ts'
import type {
  StoredAttempt,
  StoredNode,
  StoredNodeChild,
  StoredRun,
} from './state.ts'
import type { WorkflowRetentionPruner, WorkflowStore } from './store.ts'
import type { WorkflowWakeEvents } from './wake-events.ts'
import { continueRun } from './commands.ts'
import { dispatchTaskRunAttempt } from './coordinator/attempt.ts'
import {
  createAttemptExecutor,
  createRunCoordinationExecutor,
} from './in-memory/executors.ts'
import { inspectQueueItem } from './in-memory/queue.ts'
import { createRun } from './in-memory/records.ts'
import { createScheduler } from './in-memory/scheduler.ts'
import { createState } from './in-memory/state.ts'
import { createStore } from './in-memory/store.ts'

const DEFAULT_MAX_DELIVERIES = 20

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
  options: {
    readonly maxDeliveries?: number
  } = {},
): InMemoryWorkflowRuntime {
  const state = createState(options.maxDeliveries ?? DEFAULT_MAX_DELIVERIES)
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
      const started = createRun(state, run)
      if (!started.created) return started.run

      const command = continueRun(started.run)
      if (startAt) {
        await runCoordinationExecutor.enqueueDelayed(command, startAt)
      } else {
        await runCoordinationExecutor.enqueue(command)
      }
      return started.run
    },
    async startTaskRun({ run, taskName, taskInput, idempotencyKey, startAt }) {
      const started = createRun(state, run)
      if (!started.created) return started.run

      await dispatchTaskRunAttempt(
        { store, runCoordinationExecutor, attemptExecutor },
        {
          taskName,
          taskRunId: started.run.id,
          taskInput,
          ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
          startAt,
          failRunOnDispatchFailure: true,
        },
      )
      return started.run
    },
  }

  return {
    store,
    retentionPruner: store,
    runCoordinationExecutor,
    attemptExecutor,
    atomicStart,
    scheduler,
    inspect: () => ({
      runs: [...state.runs.values()],
      nodes: [...state.nodes.values()],
      children: [...state.children.values()],
      attempts: [...state.attempts.values()],
      continueRunCommands: state.continueCommands.map(inspectQueueItem),
      activityCommands: state.attemptCommands
        .filter(
          (item): item is QueueItem<ActivityAttemptCommand> =>
            item.payload.kind === 'activityAttempt',
        )
        .map(inspectQueueItem),
      taskCommands: state.attemptCommands
        .filter(
          (item): item is QueueItem<TaskAttemptCommand> =>
            item.payload.kind === 'taskAttempt',
        )
        .map(inspectQueueItem),
      schedules: [...state.schedules.values()],
    }),
    wakeEvents: {
      onCommand: (kind, listener) =>
        state.subscribe(state.commandWakeListeners, kind, listener),
      onCancellation: (runId, listener) =>
        state.subscribe(state.cancellationWakeListeners, runId, listener),
      onRunEvent: (rootRunId, listener) =>
        state.subscribe(state.runEventWakeListeners, rootRunId, listener),
      dispose() {
        state.commandWakeListeners.clear()
        state.cancellationWakeListeners.clear()
        state.runEventWakeListeners.clear()
      },
    },
  }
}
