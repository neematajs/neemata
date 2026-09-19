import type { RetryPolicy } from '../../types/index.ts'
import type { AttemptCommand, ClaimedAttempt } from '../commands.ts'
import type { RunCoordinationExecutor, RuntimeDeps } from '../executors.ts'
import type { RunSnapshot, StoredAttempt, StoredNodeChild } from '../state.ts'
import type { WorkflowStore } from '../store.ts'
import type { WorkflowRuntimeAtomicCompletion } from './atomic.ts'
import { parseChildKey } from '../child-key.ts'
import { continueRun } from '../commands.ts'
import {
  completeRunAndWakeParent,
  failRunAndWakeParent,
} from '../coordinator/sinks.ts'
import { runAtomicCompletion } from './atomic.ts'
import { WorkflowAttemptTimeoutError } from './heartbeat.ts'
import { retryAttempt } from './retry.ts'

export type WorkerCommandResult = {
  readonly status: 'processed' | 'released'
}

type AttemptInput = RuntimeDeps & {
  readonly claimed: ClaimedAttempt
  readonly atomicCompletion?: WorkflowRuntimeAtomicCompletion
}

export async function loadAttemptState(
  store: WorkflowStore,
  command: AttemptCommand,
): Promise<{
  readonly snapshot: RunSnapshot | undefined
  readonly child: StoredNodeChild | undefined
  readonly attempt: StoredAttempt | undefined
}> {
  const snapshot = await store.loadRunSnapshot(command.runId)
  const child = snapshot?.children.find(
    (candidate) =>
      candidate.nodeName === command.nodeName &&
      candidate.childKey === command.childKey,
  )
  const attempt = snapshot?.attempts.find(
    (candidate) => candidate.id === command.attemptId,
  )
  return { snapshot, child, attempt }
}

export function isFreshAttempt(
  command: Pick<AttemptCommand, 'attemptId' | 'leaseToken'>,
  child: StoredNodeChild | undefined,
  storedAttempt: StoredAttempt | undefined,
): boolean {
  return (
    child !== undefined &&
    child.currentAttemptId === command.attemptId &&
    storedAttempt !== undefined &&
    storedAttempt.status === 'started' &&
    storedAttempt.leaseToken === command.leaseToken
  )
}

/**
 * No implementation can execute this command. Released with `unroutable` so
 * definition drift ends in dead-lettering instead of a claim/release loop.
 */
export async function releaseUnroutable(
  input: AttemptInput,
  message: string,
): Promise<WorkerCommandResult> {
  await input.attemptExecutor.release(input.claimed, {
    reason: 'unroutable',
    error: new Error(message),
  })
  return { status: 'released' }
}

export async function ackTerminalAttempt(
  input: AttemptInput,
): Promise<WorkerCommandResult> {
  return await runAtomicCompletion(input, async (scoped) => {
    await scoped.attemptExecutor.ack(scoped.claimed)
    return { status: 'processed' }
  })
}

export async function settleAttemptSuccess(
  input: AttemptInput,
  params: {
    readonly command: AttemptCommand
    readonly output: unknown
    readonly taskRun: boolean
  },
): Promise<WorkerCommandResult> {
  const { command, output } = params
  const attempt = await input.store.completeCurrentAttempt({
    attemptId: command.attemptId,
    leaseToken: command.leaseToken,
    output,
  })
  if (!attempt) {
    await input.attemptExecutor.ack(input.claimed)
    return { status: 'processed' }
  }

  return await settleCompleted(input, params)
}

export async function settleAttemptFailure(
  input: AttemptInput,
  params: {
    readonly command: AttemptCommand
    readonly error: unknown
    readonly retry?: RetryPolicy
    readonly taskRun: boolean
  },
): Promise<WorkerCommandResult> {
  const { command, error } = params
  const attempt =
    error instanceof WorkflowAttemptTimeoutError
      ? await input.store.timeoutCurrentAttempt({
          attemptId: command.attemptId,
          leaseToken: command.leaseToken,
          error,
        })
      : await input.store.failCurrentAttempt({
          attemptId: command.attemptId,
          leaseToken: command.leaseToken,
          error,
        })

  if (attempt) {
    const retried = await retryAttempt(input, {
      command,
      failedAttempt: attempt,
      retry: params.retry,
    })
    if (!retried) {
      await input.store.failNodeChild({
        runId: command.runId,
        nodeName: command.nodeName,
        childKey: command.childKey,
        error,
      })
      return await settleFailed(input, params)
    }
  }

  await input.attemptExecutor.ack(input.claimed)
  return { status: 'processed' }
}

export async function reconcileStaleAttempt(
  input: AttemptInput,
  command: AttemptCommand,
  child: StoredNodeChild | undefined,
  storedAttempt: StoredAttempt | undefined,
  taskRun: boolean,
): Promise<WorkerCommandResult> {
  const isCurrentAttempt = child?.currentAttemptId === command.attemptId

  // Downstream writes are idempotent, so the settled current attempt always
  // replays its full completion path — a crash after any single write (child,
  // node, run) is repaired on redelivery.
  if (child && isCurrentAttempt && storedAttempt?.status === 'completed') {
    const { output } = storedAttempt
    await input.store.completeNodeChild({
      runId: command.runId,
      nodeName: command.nodeName,
      childKey: command.childKey,
      output,
    })
    return await settleCompleted(input, { command, output, taskRun })
  }

  if (
    child &&
    isCurrentAttempt &&
    isFailedAttemptStatus(storedAttempt?.status)
  ) {
    const error =
      storedAttempt?.error ??
      new Error(`Workflow attempt [${command.attemptId}] failed`)
    await input.store.failNodeChild({
      runId: command.runId,
      nodeName: command.nodeName,
      childKey: command.childKey,
      error,
    })
    return await settleFailed(input, { command, error, taskRun })
  }

  if (
    child &&
    storedAttempt &&
    ((storedAttempt.status === 'completed' && child.status === 'completed') ||
      (isFailedAttemptStatus(storedAttempt.status) &&
        child.status === 'failed'))
  ) {
    await enqueueContinueRun(input.runCoordinationExecutor, command)
  }

  await input.attemptExecutor.ack(input.claimed)
  return { status: 'processed' }
}

/**
 * Propagates a settled attempt to its node and run. A task run has no
 * coordinator behind it, so the worker finishes it here; a workflow run is
 * handed back to a coordination pass.
 */
async function settleCompleted(
  input: AttemptInput,
  params: {
    readonly command: AttemptCommand
    readonly output: unknown
    readonly taskRun: boolean
  },
): Promise<WorkerCommandResult> {
  const { command, output } = params
  if (shouldCompleteNodeFromAttempt(command.childKey)) {
    await input.store.completeNode({
      runId: command.runId,
      nodeName: command.nodeName,
      output,
    })
  }
  if (params.taskRun) {
    await completeRunAndWakeParent(input, { runId: command.runId, output })
  } else {
    await enqueueContinueRun(input.runCoordinationExecutor, command)
  }

  await input.attemptExecutor.ack(input.claimed)
  return { status: 'processed' }
}

async function settleFailed(
  input: AttemptInput,
  params: {
    readonly command: AttemptCommand
    readonly error: unknown
    readonly taskRun: boolean
  },
): Promise<WorkerCommandResult> {
  const { command, error } = params
  if (shouldCompleteNodeFromAttempt(command.childKey)) {
    await input.store.failNode({
      runId: command.runId,
      nodeName: command.nodeName,
      error,
    })
  }
  if (params.taskRun) {
    await failRunAndWakeParent(input, { runId: command.runId, error })
  } else {
    await enqueueContinueRun(input.runCoordinationExecutor, command)
  }

  await input.attemptExecutor.ack(input.claimed)
  return { status: 'processed' }
}

/**
 * Fan-out members and map items aggregate in the coordinator; only
 * single-child nodes complete straight from their attempt.
 */
export function shouldCompleteNodeFromAttempt(childKey: string): boolean {
  const parsed = parseChildKey(childKey)
  return parsed?.kind === 'self' || parsed?.kind === 'case'
}

function isFailedAttemptStatus(
  status: StoredAttempt['status'] | undefined,
): status is 'failed' | 'timedOut' {
  return status === 'failed' || status === 'timedOut'
}

export async function enqueueContinueRun(
  runCoordinationExecutor: RunCoordinationExecutor,
  command: AttemptCommand,
): Promise<void> {
  await runCoordinationExecutor.enqueue(
    continueRun({ id: command.runId, workflowName: command.workflowName }),
  )
}
