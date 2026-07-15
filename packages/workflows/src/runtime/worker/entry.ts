import type { Container } from '@nmtjs/core'

import type {
  TaskImplementation,
  WorkflowImplementation,
} from '../../implement/index.ts'
import type {
  AnyTaskDefinition,
  AnyWorkflowDefinition,
} from '../../types/index.ts'
import type { ClaimedAttempt, ClaimedCommand } from '../commands.ts'
import type { AttemptExecutor, RunCoordinationExecutor } from '../executors.ts'
import type { WorkflowStore } from '../store.ts'
import type {
  WorkflowCommandWakeKind,
  WorkflowWakeEvents,
} from '../wake-events.ts'
import { continueWorkflowRun } from '../coordinator.ts'
import { runActivityAttempt } from './activity-attempt.ts'
import {
  runAtomicContinuation,
  type WorkflowRuntimeAtomicCompletion,
  type WorkflowRuntimeAtomicContinuation,
} from './atomic.ts'
import { isAttemptShutdown } from './heartbeat.ts'
import {
  DEFAULT_LEASE_MS,
  drainWorkerPool,
  isAttemptHeartbeatLeaseLost,
  isStaleWorkflowCommandAck,
  serveWorkerPool,
  withDefaultRetentionPruner,
  type WorkerDriver,
  type WorkerLoopOptions,
  type WorkerLoopResult,
  type WorkerMaintenanceHook,
} from './loop.ts'
import {
  reapDeadWorkflowCommands,
  timeoutExpiredWorkflowRuns,
} from './maintenance.ts'
import { runTaskAttempt } from './task-attempt.ts'

const DEFAULT_REAPING_EVERY_MS = 30_000
const DEFAULT_RUN_TIMEOUTS_EVERY_MS = 60_000

export type WorkerReapingOptions = {
  readonly everyMs?: number
  readonly batchSize?: number
}

export type WorkerRunTimeoutsOptions = {
  readonly everyMs?: number
  readonly batchSize?: number
}

type AnyWorkflowImplementation = WorkflowImplementation<
  AnyWorkflowDefinition,
  any
>
type AnyTaskImplementation = TaskImplementation<AnyTaskDefinition, any>

export type RunWorkflowWorkerInput = WorkerLoopOptions & {
  readonly store: WorkflowStore
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly attemptExecutor: AttemptExecutor
  readonly atomicContinuation?: WorkflowRuntimeAtomicContinuation
  readonly wakeEvents?: WorkflowWakeEvents
  readonly workflows: readonly AnyWorkflowImplementation[]
  readonly container: Pick<Container, 'createContext'>
  readonly reaping?: false | WorkerReapingOptions
  readonly runTimeouts?: false | WorkerRunTimeoutsOptions
}

export type RunExecutionWorkerInput = WorkerLoopOptions & {
  readonly store: WorkflowStore
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly attemptExecutor: AttemptExecutor
  readonly atomicCompletion?: WorkflowRuntimeAtomicCompletion
  readonly wakeEvents?: WorkflowWakeEvents
  readonly workflows: readonly AnyWorkflowImplementation[]
  readonly activityNames?: readonly string[]
  readonly tasks: readonly AnyTaskImplementation[]
  readonly taskNames?: readonly string[]
  readonly container: Pick<Container, 'createContext'>
  readonly reaping?: false | WorkerReapingOptions
}

type MaintenanceDeps = {
  readonly store: WorkflowStore
  readonly attemptExecutor: AttemptExecutor
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly maintenance?: readonly WorkerMaintenanceHook[]
  readonly reaping?: false | WorkerReapingOptions
}

// Reaping is on by default: a dead-lettered command must fail its run instead
// of leaving a zombie only the dead-command table knows about.
function withReapingHook(
  input: MaintenanceDeps,
): readonly WorkerMaintenanceHook[] {
  const hooks = [...(input.maintenance ?? [])]
  if (input.reaping !== false) {
    const options = input.reaping
    hooks.push({
      everyMs: options?.everyMs ?? DEFAULT_REAPING_EVERY_MS,
      run: async () => {
        await reapDeadWorkflowCommands({
          store: input.store,
          attemptExecutor: input.attemptExecutor,
          runCoordinationExecutor: input.runCoordinationExecutor,
          batchSize: options?.batchSize,
        })
      },
    })
  }
  return hooks
}

function withRunTimeoutsHook(
  input: RunWorkflowWorkerInput,
  hooks: readonly WorkerMaintenanceHook[],
): readonly WorkerMaintenanceHook[] {
  if (input.runTimeouts === false) return hooks
  const options = input.runTimeouts
  return [
    ...hooks,
    {
      everyMs: options?.everyMs ?? DEFAULT_RUN_TIMEOUTS_EVERY_MS,
      run: async (now: Date) => {
        await timeoutExpiredWorkflowRuns({
          store: input.store,
          attemptExecutor: input.attemptExecutor,
          runCoordinationExecutor: input.runCoordinationExecutor,
          workflows: input.workflows,
          batchSize: options?.batchSize,
          now,
        })
      },
    },
  ]
}

function commandWake(
  wakeEvents: WorkflowWakeEvents | undefined,
  kind: WorkflowCommandWakeKind,
): ((listener: () => void) => () => void) | undefined {
  if (!wakeEvents) return undefined
  return (listener) => wakeEvents.onCommand(kind, listener)
}

function executionWake(
  wakeEvents: WorkflowWakeEvents | undefined,
): ((listener: () => void) => () => void) | undefined {
  if (!wakeEvents) return undefined
  return (listener) => {
    const unsubscribeActivity = wakeEvents.onCommand('activity', listener)
    const unsubscribeTask = wakeEvents.onCommand('task', listener)
    return () => {
      unsubscribeActivity()
      unsubscribeTask()
    }
  }
}

export async function runWorkflowWorker(
  input: RunWorkflowWorkerInput,
): Promise<WorkerLoopResult> {
  return drainWorkerPool(workflowWorkerOptions(input), workflowDriver(input))
}

export async function serveWorkflowWorker(
  input: RunWorkflowWorkerInput & { readonly signal: AbortSignal },
): Promise<WorkerLoopResult> {
  return serveWorkerPool(
    { ...workflowWorkerOptions(input), signal: input.signal },
    workflowDriver(input),
  )
}

function workflowWorkerOptions(input: RunWorkflowWorkerInput) {
  const maintenance = withRunTimeoutsHook(input, withReapingHook(input))
  return withDefaultRetentionPruner({
    ...input,
    maintenance,
    onWake: commandWake(input.wakeEvents, 'continue'),
  })
}

function workflowDriver(
  input: RunWorkflowWorkerInput,
): WorkerDriver<ClaimedCommand> {
  const workflowNames = input.workflows.map(
    (implementation) => implementation.workflow.name,
  )
  return {
    claim: () =>
      input.runCoordinationExecutor.claim({
        workerId: input.workerId,
        workflowNames,
        leaseMs: input.leaseMs ?? DEFAULT_LEASE_MS,
      }),
    abandon: (claimed) => input.runCoordinationExecutor.release(claimed),
    // Continuations stay atomic during shutdown; interrupting coordination
    // mid-write is less safe than waiting for the claimed command to finish.
    async execute(claimed) {
      try {
        return await runAtomicContinuation(input, async (scoped) => {
          const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS
          const result = await continueWorkflowRun({
            store: scoped.store,
            runCoordinationExecutor: scoped.runCoordinationExecutor,
            attemptExecutor: scoped.attemptExecutor,
            container: input.container,
            workflows: input.workflows,
            workerId: input.workerId,
            command: claimed.command,
            leaseMs,
          })
          if (result.status !== 'processed') {
            await scoped.runCoordinationExecutor.release(claimed)
            return false
          }

          await scoped.runCoordinationExecutor.ack(claimed)
          return true
        })
      } catch (error) {
        if (isStaleWorkflowCommandAck(error)) {
          await input.runCoordinationExecutor.release(claimed)
          return false
        }
        await input.runCoordinationExecutor.release(claimed, { error })
        throw error
      }
    },
  }
}

export async function runExecutionWorker(
  input: RunExecutionWorkerInput,
): Promise<WorkerLoopResult> {
  return drainWorkerPool(executionWorkerOptions(input), executionDriver(input))
}

export async function serveExecutionWorker(
  input: RunExecutionWorkerInput & { readonly signal: AbortSignal },
): Promise<WorkerLoopResult> {
  return serveWorkerPool(
    { ...executionWorkerOptions(input), signal: input.signal },
    executionDriver(input),
  )
}

function executionWorkerOptions(input: RunExecutionWorkerInput) {
  return withDefaultRetentionPruner({
    ...input,
    maintenance: withReapingHook(input),
    onWake: executionWake(input.wakeEvents),
  })
}

function executionDriver(
  input: RunExecutionWorkerInput,
): WorkerDriver<ClaimedAttempt> {
  const workflowNames = input.workflows.map(
    (implementation) => implementation.workflow.name,
  )
  const activityNames =
    input.activityNames ?? collectWorkflowActivityNames(input.workflows)
  const taskNames =
    input.taskNames ??
    input.tasks.map((implementation) => implementation.task.name)
  return {
    claim: () =>
      input.attemptExecutor.claim({
        workerId: input.workerId,
        workflowNames,
        activityNames,
        taskNames,
        leaseMs: input.leaseMs ?? DEFAULT_LEASE_MS,
      }),
    abandon: (claimed) => input.attemptExecutor.release(claimed),
    async execute(claimed, signal) {
      try {
        const result =
          claimed.command.kind === 'activityAttempt'
            ? await runActivityAttempt({ ...input, claimed, signal })
            : await runTaskAttempt({ ...input, claimed, signal })
        return result.status === 'processed'
      } catch (error) {
        if (
          isStaleWorkflowCommandAck(error) ||
          isAttemptHeartbeatLeaseLost(error) ||
          isAttemptShutdown(error)
        ) {
          await input.attemptExecutor.release(claimed)
          return false
        }
        await input.attemptExecutor.release(claimed, { error })
        throw error
      }
    },
  }
}

export function collectWorkflowActivityNames(
  workflows: readonly Pick<AnyWorkflowImplementation, 'nodes'>[],
): readonly string[] {
  const names = new Set<string>()
  for (const workflow of workflows) {
    for (const node of workflow.nodes) {
      if (node.kind === 'activity') {
        names.add(node.activity.name)
        continue
      }

      if (node.kind === 'branch' || node.kind === 'parallel') {
        for (const member of Object.values(node.cases)) {
          if (member.kind === 'activity') names.add(member.activity.name)
        }
      }
    }
  }

  return [...names]
}

export function collectWorkflowTaskNames(
  workflows: readonly Pick<AnyWorkflowImplementation, 'nodes'>[],
): readonly string[] {
  const names = new Set<string>()
  for (const workflow of workflows) {
    for (const node of workflow.nodes) {
      if (node.kind === 'task' || node.kind === 'mapTask') {
        names.add(node.target.name)
        continue
      }

      if (node.kind === 'branch' || node.kind === 'parallel') {
        for (const member of Object.values(node.cases)) {
          if (member.kind === 'task') names.add(member.target.name)
        }
      }
    }
  }

  return [...names]
}

export function collectChildWorkflowNames(
  workflows: readonly Pick<AnyWorkflowImplementation, 'nodes'>[],
): readonly string[] {
  const names = new Set<string>()
  for (const workflow of workflows) {
    for (const node of workflow.nodes) {
      if (node.kind === 'workflow' || node.kind === 'mapWorkflow') {
        names.add(node.target.name)
        continue
      }

      if (node.kind === 'branch' || node.kind === 'parallel') {
        for (const member of Object.values(node.cases)) {
          if (member.kind === 'workflow') names.add(member.target.name)
        }
      }
    }
  }

  return [...names]
}
