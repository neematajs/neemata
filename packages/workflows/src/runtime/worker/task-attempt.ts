import type { Container, DependencyContext } from '@nmtjs/core'

import type { TaskImplementation } from '../../implement/index.ts'
import type { AnyTaskDefinition } from '../../types/index.ts'
import type { ClaimedAttempt } from '../commands.ts'
import type { AttemptExecutor, RunCoordinationExecutor } from '../executors.ts'
import type { WorkflowStore } from '../store.ts'
import { parseDurationMs } from '../duration.ts'
import { createWorkflowRuntimeRegistry } from '../registry.ts'
import { isTerminalRunStatus } from '../status.ts'
import { wakeParentRun } from '../wake.ts'
import { decodeSchemaValue } from './activity-attempt.ts'
import {
  runAtomicCompletion,
  type WorkflowRuntimeAtomicCompletion,
} from './atomic.ts'
import {
  runWithAttemptHeartbeat,
  WorkflowAttemptTimeoutError,
} from './heartbeat.ts'
import { isAttemptHeartbeatLeaseLost } from './loop.ts'
import {
  ackTerminalAttempt,
  enqueueContinueRun,
  isFreshAttempt,
  reconcileStaleAttempt,
  shouldCompleteNodeFromAttempt,
  type WorkerCommandResult,
} from './reconcile.ts'
import { retryTaskAttempt } from './retry.ts'

type AnyTaskImplementation = TaskImplementation<AnyTaskDefinition, any>

export type RunTaskAttemptInput = {
  readonly store: WorkflowStore
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly attemptExecutor: AttemptExecutor
  readonly atomicCompletion?: WorkflowRuntimeAtomicCompletion
  readonly tasks: readonly AnyTaskImplementation[]
  readonly workerId: string
  readonly claimed: ClaimedAttempt
  readonly leaseMs?: number
  readonly container: Pick<Container, 'createContext'>
}

export async function runTaskAttempt(
  input: RunTaskAttemptInput,
): Promise<WorkerCommandResult> {
  const command = input.claimed.command
  if (command.kind !== 'taskAttempt') {
    throw new Error(`Unsupported attempt command kind [${command.kind}]`)
  }

  const snapshot = await input.store.loadRunSnapshot(command.runId)
  const storedNode = snapshot?.nodes.find(
    (node) => node.name === command.nodeName,
  )
  const storedAttempt = snapshot?.attempts.find(
    (attempt) => attempt.id === command.attemptId,
  )
  if (snapshot && isTerminalRunStatus(snapshot.run.status)) {
    return await ackTerminalAttempt(input)
  }

  if (!isFreshAttempt(command, storedNode, storedAttempt)) {
    return await runAtomicCompletion(input, (scoped) =>
      reconcileStaleAttempt(scoped, command, storedNode, storedAttempt),
    )
  }

  if (snapshot?.run.workflowName !== command.workflowName) {
    await input.attemptExecutor.release(input.claimed)
    return { status: 'released' }
  }

  const registry = createWorkflowRuntimeRegistry({
    tasks: input.tasks,
  })
  const task = registry.getTask(command.taskName)
  if (!task) {
    await input.attemptExecutor.release(input.claimed)
    return { status: 'released' }
  }

  let output: unknown
  try {
    const timeoutMs = parseDurationMs(command.timeout ?? task.task.timeout)
    output = await runWithAttemptHeartbeat(
      input,
      async () => {
        const ctx = await input.container.createContext(task.dependencies)
        return await task.handler(ctx as DependencyContext<any>, command.input)
      },
      timeoutMs === undefined
        ? undefined
        : {
            timeoutMs,
            createError: () =>
              new WorkflowAttemptTimeoutError({
                runId: command.runId,
                nodeName: command.nodeName,
                attemptId: command.attemptId,
                timeoutMs,
              }),
          },
    )
    output = decodeSchemaValue(
      task.task.output,
      output,
      `task output [${task.task.name}]`,
    )
  } catch (error) {
    if (isAttemptHeartbeatLeaseLost(error)) throw error
    return await runAtomicCompletion(input, async (scoped) => {
      const attempt = await scoped.store.failCurrentAttempt({
        attemptId: command.attemptId,
        leaseToken: command.leaseToken,
        error,
      })

      if (attempt) {
        const retried = await retryTaskAttempt(scoped, {
          command,
          failedAttempt: attempt,
          retry: task.task.retry,
        })
        if (retried) {
          await scoped.attemptExecutor.ack(scoped.claimed)
          return { status: 'processed' }
        }

        await scoped.store.failNode({
          runId: command.runId,
          nodeName: command.nodeName,
          error,
        })
        if (snapshot?.run.kind === 'task') {
          const failed = await scoped.store.failRun({
            runId: command.runId,
            error,
          })
          await wakeParentRun({
            store: scoped.store,
            runCoordinationExecutor: scoped.runCoordinationExecutor,
            run: failed,
          })
          await scoped.attemptExecutor.ack(scoped.claimed)
          return { status: 'processed' }
        }
        await enqueueContinueRun(scoped.runCoordinationExecutor, command)
      }

      await scoped.attemptExecutor.ack(scoped.claimed)
      return { status: 'processed' }
    })
  }

  return await runAtomicCompletion(input, async (scoped) => {
    const attempt = await scoped.store.completeCurrentAttempt({
      attemptId: command.attemptId,
      leaseToken: command.leaseToken,
      output,
    })
    if (!attempt) {
      await scoped.attemptExecutor.ack(scoped.claimed)
      return { status: 'processed' }
    }

    if (snapshot?.run.kind === 'task') {
      await scoped.store.completeNode({
        runId: command.runId,
        nodeName: command.nodeName,
        output,
      })
      const completed = await scoped.store.completeRun({
        runId: command.runId,
        output,
      })
      await wakeParentRun({
        store: scoped.store,
        runCoordinationExecutor: scoped.runCoordinationExecutor,
        run: completed,
      })
      await scoped.attemptExecutor.ack(scoped.claimed)
      return { status: 'processed' }
    }

    if (shouldCompleteNodeFromAttempt(storedNode)) {
      await scoped.store.completeNode({
        runId: command.runId,
        nodeName: command.nodeName,
        output,
      })
    }
    await enqueueContinueRun(scoped.runCoordinationExecutor, command)
    await scoped.attemptExecutor.ack(scoped.claimed)
    return { status: 'processed' }
  })
}
