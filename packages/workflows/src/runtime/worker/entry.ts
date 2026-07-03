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
import {
  DEFAULT_LEASE_MS,
  isAttemptHeartbeatLeaseLost,
  isStaleWorkflowCommandAck,
  runWorkerLoop,
  withDefaultRetentionPruner,
  type WorkerLoopOptions,
  type WorkerLoopResult,
} from './loop.ts'
import { runTaskAttempt } from './task-attempt.ts'

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
}

export type RunActivityWorkerInput = WorkerLoopOptions & {
  readonly store: WorkflowStore
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly attemptExecutor: AttemptExecutor
  readonly atomicCompletion?: WorkflowRuntimeAtomicCompletion
  readonly workflows: readonly AnyWorkflowImplementation[]
  readonly activityNames?: readonly string[]
  readonly container: Pick<Container, 'createContext'>
}

export type RunTaskWorkerInput = WorkerLoopOptions & {
  readonly store: WorkflowStore
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly attemptExecutor: AttemptExecutor
  readonly atomicCompletion?: WorkflowRuntimeAtomicCompletion
  readonly tasks: readonly AnyTaskImplementation[]
  readonly container: Pick<Container, 'createContext'>
}

export async function runWorkflowWorker(
  input: RunWorkflowWorkerInput,
): Promise<WorkerLoopResult> {
  const workflowNames = input.workflows.map(
    (implementation) => implementation.workflow.name,
  )

  return runWorkerLoop(withDefaultRetentionPruner(input), async () => {
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
  })
}

export async function runActivityWorker(
  input: RunActivityWorkerInput,
): Promise<WorkerLoopResult> {
  const workflowNames = input.workflows.map(
    (implementation) => implementation.workflow.name,
  )
  const activityNames =
    input.activityNames ?? collectWorkflowActivityNames(input.workflows)

  return runWorkerLoop(withDefaultRetentionPruner(input), async () => {
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
        isAttemptHeartbeatLeaseLost(error)
      ) {
        await input.attemptExecutor.release(claimed)
        return false
      }
      await input.attemptExecutor.release(claimed, { error })
      throw error
    }
  })
}

export async function runTaskWorker(
  input: RunTaskWorkerInput,
): Promise<WorkerLoopResult> {
  const taskNames = input.tasks.map(
    (implementation) => implementation.task.name,
  )

  return runWorkerLoop(withDefaultRetentionPruner(input), async () => {
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
        isAttemptHeartbeatLeaseLost(error)
      ) {
        await input.attemptExecutor.release(claimed)
        return false
      }
      await input.attemptExecutor.release(claimed, { error })
      throw error
    }
  })
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
