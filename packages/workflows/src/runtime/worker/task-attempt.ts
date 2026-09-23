import type { TaskImplementation } from '../../implement/index.ts'
import type { AnyTaskDefinition } from '../../types/index.ts'
import type { ClaimedAttempt } from '../commands.ts'
import type { AttemptExecutor, RunCoordinationExecutor } from '../executors.ts'
import type { WorkflowStore } from '../store.ts'
import type { WorkflowWakeEvents } from '../wake-events.ts'
import { decodeStoredValue, encodeStoredValue } from '../codec.ts'
import { cancelRunAndWakeParent } from '../coordinator/sinks.ts'
import { parseDurationMs } from '../duration.ts'
import { StaleWriteFenceError } from '../errors.ts'
import { WorkflowCleanupTimeoutError, type HandlerRunner } from '../handler.ts'
import { createWorkflowRuntimeRegistry } from '../registry.ts'
import { isTerminalRunStatus } from '../status.ts'
import { wakeParentRun } from '../wake.ts'
import {
  runAtomicCompletion,
  type WorkflowRuntimeAtomicCompletion,
} from './atomic.ts'
import {
  isAttemptCancellationObserved,
  isAttemptShutdown,
  runWithAttemptHeartbeat,
  WorkflowAttemptTimeoutError,
} from './heartbeat.ts'
import { isAttemptHeartbeatLeaseLost } from './loop.ts'
import {
  ackTerminalAttempt,
  enqueueContinueRun,
  isFreshAttempt,
  reconcileStaleAttempt,
  scopeToAttempt,
  shouldCompleteNodeFromAttempt,
  type WorkerCommandResult,
} from './reconcile.ts'
import { retryAttempt } from './retry.ts'

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
  readonly signal?: AbortSignal
  readonly wakeEvents?: WorkflowWakeEvents
  readonly handlers: HandlerRunner
  /** Passed to every handler; see `Env` in the implementation API. */
  readonly env?: unknown
}

export async function runTaskAttempt(
  input: RunTaskAttemptInput,
): Promise<WorkerCommandResult> {
  const command = input.claimed.command
  if (command.kind !== 'taskAttempt') {
    throw new Error(`Unsupported attempt command kind [${command.kind}]`)
  }

  const snapshot = await input.store.loadRunSnapshot(command.runId)
  const storedChild = snapshot?.children.find(
    (child) =>
      child.nodeName === command.nodeName &&
      child.childKey === command.childKey,
  )
  const storedAttempt = snapshot?.attempts.find(
    (attempt) => attempt.id === command.attemptId,
  )
  if (snapshot?.run.kind === 'task' && snapshot.run.status === 'cancelling') {
    return await settleCancelledTaskRun(input)
  }
  if (snapshot && isTerminalRunStatus(snapshot.run.status)) {
    return await ackTerminalAttempt(
      input,
      snapshot.run.kind === 'task' ? snapshot.run : undefined,
    )
  }

  if (!isFreshAttempt(command, storedChild, storedAttempt)) {
    return await runAtomicCompletion(input, (scoped) =>
      reconcileStaleAttempt(
        scopeToAttempt(scoped, command),
        command,
        storedChild,
        storedAttempt,
        {
          currentAttempt: snapshot?.attempts.find(
            (attempt) => attempt.id === storedChild?.currentAttemptId,
          ),
          resolveRetry: () =>
            command.retry ??
            createWorkflowRuntimeRegistry({ tasks: input.tasks }).getTask(
              command.taskName,
            )?.task.retry,
        },
      ),
    )
  }

  if (snapshot?.run.workflowName !== command.workflowName) {
    await input.attemptExecutor.release(input.claimed, {
      reason: 'unroutable',
      error: new Error(
        `Run [${command.runId}] workflow does not match command workflow [${command.workflowName}]`,
      ),
    })
    return { status: 'released' }
  }

  const registry = createWorkflowRuntimeRegistry({
    tasks: input.tasks,
  })
  const task = registry.getTask(command.taskName)
  if (!task) {
    await input.attemptExecutor.release(input.claimed, {
      reason: 'unroutable',
      error: new Error(
        `No registered task implementation [${command.taskName}]`,
      ),
    })
    return { status: 'released' }
  }

  // Task runs are advanced by workers, never by the coordinator, so this is
  // the queued → running transition for them.
  if (snapshot.run.kind === 'task') {
    await input.store.markRunRunning({ runId: command.runId })
  }

  let output: unknown
  try {
    const timeoutMs = parseDurationMs(command.timeout ?? task.task.timeout)
    output = await runWithAttemptHeartbeat(
      input,
      (lifecycle) =>
        input.handlers.run(
          () =>
            task.handler(
              decodeStoredValue(
                task.task.input,
                command.input,
                `task input [${task.task.name}]`,
              ),
              lifecycle,
              input.env,
            ),
          lifecycle.signal,
        ),
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
    output = encodeStoredValue(
      task.task.output,
      output,
      `task output [${task.task.name}]`,
    )
  } catch (error) {
    if (
      error instanceof WorkflowCleanupTimeoutError ||
      isAttemptHeartbeatLeaseLost(error) ||
      isAttemptShutdown(error)
    ) {
      throw error
    }
    if (isAttemptCancellationObserved(error)) {
      return snapshot.run.kind === 'task'
        ? await settleCancelledTaskRun(input)
        : await ackTerminalAttempt(input)
    }
    return await runAtomicCompletion(input, async (claimScoped) => {
      const scoped = scopeToAttempt(claimScoped, command)
      const attempt =
        error instanceof WorkflowAttemptTimeoutError
          ? await scoped.store.timeoutCurrentAttempt({
              attemptId: command.attemptId,
              leaseToken: command.leaseToken,
              error,
            })
          : await scoped.store.failCurrentAttempt({
              attemptId: command.attemptId,
              leaseToken: command.leaseToken,
              error,
            })

      if (attempt) {
        const retried = await retryAttempt(scoped, {
          command,
          failedAttempt: attempt,
          retry: command.retry ?? task.task.retry,
        })
        if (retried) {
          await scoped.attemptExecutor.ack(scoped.claimed)
          return { status: 'processed' }
        }

        await scoped.store.failNodeChild({
          runId: command.runId,
          nodeName: command.nodeName,
          childKey: command.childKey,
          error,
        })
        if (shouldCompleteNodeFromAttempt(command.childKey)) {
          await scoped.store.failNode({
            runId: command.runId,
            nodeName: command.nodeName,
            error,
          })
        }
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

  return await runAtomicCompletion(input, async (claimScoped) => {
    const scoped = scopeToAttempt(claimScoped, command)
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

    if (shouldCompleteNodeFromAttempt(command.childKey)) {
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

/**
 * Task runs have no coordinator to finish a requested cancellation, so the
 * worker that observes `cancelling` settles the run itself before dropping
 * the attempt. Idempotent against the client having already settled it: an
 * already-terminal run is left untouched. It acts for its attempt: once that
 * is no longer current, such as after a manual retry, the cancellation it
 * observed is not its to finish.
 */
async function settleCancelledTaskRun(
  input: RunTaskAttemptInput,
): Promise<WorkerCommandResult> {
  const command = input.claimed.command
  const runId = command.runId
  return await runAtomicCompletion(input, async (claimScoped) => {
    const scoped = scopeToAttempt(claimScoped, command)
    const [run] = await scoped.store.loadRuns([runId])
    if (run?.status === 'cancelling') {
      try {
        await cancelRunAndWakeParent({
          store: scoped.store,
          attemptExecutor: scoped.attemptExecutor,
          runCoordinationExecutor: scoped.runCoordinationExecutor,
          runId,
        })
      } catch (error) {
        if (!(error instanceof StaleWriteFenceError)) throw error
      }
    }
    await scoped.attemptExecutor.ack(scoped.claimed)
    return { status: 'processed' }
  })
}
