import type { Container } from '@nmtjs/core'

import type {
  AnyTaskImplementation,
  AnyWorkflowImplementation,
} from '../../implement/index.ts'
import type { ClaimedAttempt, ClaimedCommand } from '../commands.ts'
import type { RuntimeDeps } from '../executors.ts'
import type {
  WorkflowCommandWakeKind,
  WorkflowWakeEvents,
} from '../wake-events.ts'
import { continueWorkflowRun } from '../coordinator.ts'
import { DEFAULT_LEASE_MS } from '../executors.ts'
import { runActivityAttempt } from './activity-attempt.ts'
import {
  runAtomicContinuation,
  type WorkflowRuntimeAtomicCompletion,
  type WorkflowRuntimeAtomicContinuation,
} from './atomic.ts'
import { isAttemptShutdown } from './heartbeat.ts'
import {
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

/** Cadence and batch size of a periodic worker sweep. */
export type WorkerPeriodicOptions = {
  readonly everyMs?: number
  readonly batchSize?: number
}

export type WorkerReapingOptions = WorkerPeriodicOptions
export type WorkerRunTimeoutsOptions = WorkerPeriodicOptions

export type RunWorkflowWorkerInput = WorkerLoopOptions &
  RuntimeDeps & {
    readonly atomicContinuation?: WorkflowRuntimeAtomicContinuation
    readonly wakeEvents?: WorkflowWakeEvents
    readonly workflows: readonly AnyWorkflowImplementation[]
    readonly container: Pick<Container, 'createContext'>
    readonly reaping?: false | WorkerReapingOptions
    readonly runTimeouts?: false | WorkerRunTimeoutsOptions
  }

export type RunExecutionWorkerInput = WorkerLoopOptions &
  RuntimeDeps & {
    readonly atomicCompletion?: WorkflowRuntimeAtomicCompletion
    readonly wakeEvents?: WorkflowWakeEvents
    readonly workflows: readonly AnyWorkflowImplementation[]
    readonly activityNames?: readonly string[]
    readonly tasks: readonly AnyTaskImplementation[]
    readonly taskNames?: readonly string[]
    readonly container: Pick<Container, 'createContext'>
    readonly reaping?: false | WorkerReapingOptions
  }

// Reaping is on by default: a dead-lettered command must fail its run instead
// of leaving a zombie only the dead-command table knows about.
function reapingHook(
  input: RuntimeDeps & { readonly reaping?: false | WorkerReapingOptions },
): WorkerMaintenanceHook | undefined {
  if (input.reaping === false) return undefined
  const options = input.reaping
  return {
    everyMs: options?.everyMs ?? DEFAULT_REAPING_EVERY_MS,
    run: async () => {
      await reapDeadWorkflowCommands({
        ...input,
        batchSize: options?.batchSize,
      })
    },
  }
}

function runTimeoutsHook(
  input: RunWorkflowWorkerInput,
): WorkerMaintenanceHook | undefined {
  if (input.runTimeouts === false) return undefined
  const options = input.runTimeouts
  return {
    everyMs: options?.everyMs ?? DEFAULT_RUN_TIMEOUTS_EVERY_MS,
    run: async (now: Date) => {
      await timeoutExpiredWorkflowRuns({
        ...input,
        batchSize: options?.batchSize,
        now,
      })
    },
  }
}

function maintenanceHooks(
  configured: readonly WorkerMaintenanceHook[] | undefined,
  ...added: readonly (WorkerMaintenanceHook | undefined)[]
): readonly WorkerMaintenanceHook[] {
  const hooks = [...(configured ?? [])]
  for (const hook of added) {
    if (hook) hooks.push(hook)
  }
  return hooks
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
  return withDefaultRetentionPruner({
    ...input,
    maintenance: maintenanceHooks(
      input.maintenance,
      reapingHook(input),
      runTimeoutsHook(input),
    ),
    onWake: commandWake(input.wakeEvents, 'continue'),
  })
}

function workflowDriver(
  input: RunWorkflowWorkerInput,
): WorkerDriver<ClaimedCommand> {
  const workflowNames = input.workflows.map(
    (implementation) => implementation.workflow.name,
  )
  const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS
  return {
    claim: () =>
      input.runCoordinationExecutor.claim({
        workerId: input.workerId,
        workflowNames,
        leaseMs,
      }),
    abandon: (claimed) => input.runCoordinationExecutor.release(claimed),
    // Continuations stay atomic during shutdown; interrupting coordination
    // mid-write is less safe than waiting for the claimed command to finish.
    async execute(claimed) {
      try {
        return await runAtomicContinuation(input, async (scoped) => {
          const result = await continueWorkflowRun({
            ...scoped,
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
    maintenance: maintenanceHooks(input.maintenance, reapingHook(input)),
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
  const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS
  return {
    claim: () =>
      input.attemptExecutor.claim({
        workerId: input.workerId,
        workflowNames,
        activityNames,
        taskNames,
        leaseMs,
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

  return Array.from(names)
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

  return Array.from(names)
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

  return Array.from(names)
}
