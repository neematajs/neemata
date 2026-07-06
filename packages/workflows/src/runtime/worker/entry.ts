import type { Container } from '@nmtjs/core'

import type {
  TaskImplementation,
  WorkflowImplementation,
} from '../../implement/index.ts'
import type {
  AnyTaskDefinition,
  AnyWorkflowDefinition,
} from '../../types/index.ts'
import type { AttemptExecutor, RunCoordinationExecutor } from '../executors.ts'
import type { WorkflowStore } from '../store.ts'
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
  isAttemptHeartbeatLeaseLost,
  isStaleWorkflowCommandAck,
  runWorkerLoop,
  withDefaultRetentionPruner,
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
  readonly workflows: readonly AnyWorkflowImplementation[]
  readonly container: Pick<Container, 'createContext'>
  readonly reaping?: false | WorkerReapingOptions
  readonly runTimeouts?: false | WorkerRunTimeoutsOptions
}

export type RunActivityWorkerInput = WorkerLoopOptions & {
  readonly store: WorkflowStore
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly attemptExecutor: AttemptExecutor
  readonly atomicCompletion?: WorkflowRuntimeAtomicCompletion
  readonly workflows: readonly AnyWorkflowImplementation[]
  readonly activityNames?: readonly string[]
  readonly container: Pick<Container, 'createContext'>
  readonly reaping?: false | WorkerReapingOptions
}

export type RunTaskWorkerInput = WorkerLoopOptions & {
  readonly store: WorkflowStore
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly attemptExecutor: AttemptExecutor
  readonly atomicCompletion?: WorkflowRuntimeAtomicCompletion
  readonly tasks: readonly AnyTaskImplementation[]
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

export async function runWorkflowWorker(
  input: RunWorkflowWorkerInput,
): Promise<WorkerLoopResult> {
  const workflowNames = input.workflows.map(
    (implementation) => implementation.workflow.name,
  )
  const maintenance = withRunTimeoutsHook(input, withReapingHook(input))

  return runWorkerLoop(
    withDefaultRetentionPruner({ ...input, maintenance }),
    async () => {
      const claimed = await input.runCoordinationExecutor.claim({
        workerId: input.workerId,
        workflowNames,
        leaseMs: input.leaseMs ?? DEFAULT_LEASE_MS,
      })
      if (!claimed) return false

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
  )
}

export async function runActivityWorker(
  input: RunActivityWorkerInput,
): Promise<WorkerLoopResult> {
  const workflowNames = input.workflows.map(
    (implementation) => implementation.workflow.name,
  )
  const activityNames =
    input.activityNames ?? collectWorkflowActivityNames(input.workflows)

  return runWorkerLoop(
    withDefaultRetentionPruner({
      ...input,
      maintenance: withReapingHook(input),
    }),
    async () => {
      const claimed = await input.attemptExecutor.claimActivity({
        workerId: input.workerId,
        workflowNames,
        activityNames,
        leaseMs: input.leaseMs ?? DEFAULT_LEASE_MS,
      })
      if (!claimed) return false

      try {
        const result = await runActivityAttempt({ ...input, claimed })
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
  )
}

export async function runTaskWorker(
  input: RunTaskWorkerInput,
): Promise<WorkerLoopResult> {
  const taskNames = input.tasks.map(
    (implementation) => implementation.task.name,
  )

  return runWorkerLoop(
    withDefaultRetentionPruner({
      ...input,
      maintenance: withReapingHook(input),
    }),
    async () => {
      const claimed = await input.attemptExecutor.claimTask({
        workerId: input.workerId,
        taskNames,
        leaseMs: input.leaseMs ?? DEFAULT_LEASE_MS,
      })
      if (!claimed) return false

      try {
        const result = await runTaskAttempt({ ...input, claimed })
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
  )
}

function collectWorkflowActivityNames(
  workflows: readonly AnyWorkflowImplementation[],
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
