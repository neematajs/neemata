import type {
  ActivityAttemptCommand,
  ClaimedAttempt,
  TaskAttemptCommand,
} from '../commands.ts'
import type { AttemptExecutor, RunCoordinationExecutor } from '../executors.ts'
import type { StoredAttempt, StoredNodeChild } from '../state.ts'
import type { WorkflowStore } from '../store.ts'
import { parseChildKey } from '../child-key.ts'
import { wakeParentRun } from '../wake.ts'
import { runAtomicCompletion } from './atomic.ts'

export type WorkerCommandResult = {
  readonly status: 'processed' | 'released'
}

type EnqueueContinueRunCommand = ActivityAttemptCommand | TaskAttemptCommand

type RunAttemptInput = {
  readonly store: WorkflowStore
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly attemptExecutor: AttemptExecutor
  readonly claimed: ClaimedAttempt
}

export function isFreshAttempt(
  command: Pick<
    ActivityAttemptCommand | TaskAttemptCommand,
    'attemptId' | 'leaseToken'
  >,
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

export async function ackTerminalAttempt<Input extends RunAttemptInput>(
  input: Input,
): Promise<WorkerCommandResult> {
  return await runAtomicCompletion(input, async (scoped) => {
    await scoped.attemptExecutor.ack(scoped.claimed)
    return { status: 'processed' }
  })
}

export async function reconcileStaleAttempt<Input extends RunAttemptInput>(
  input: Input,
  command: EnqueueContinueRunCommand,
  child: StoredNodeChild | undefined,
  storedAttempt: StoredAttempt | undefined,
): Promise<WorkerCommandResult> {
  const isCurrentAttempt = child?.currentAttemptId === command.attemptId

  // Downstream writes are idempotent, so the settled current attempt always
  // replays its full completion path — a crash after any single write (child,
  // node, run) is repaired on redelivery.
  if (child && isCurrentAttempt && storedAttempt?.status === 'completed') {
    await input.store.completeNodeChild({
      runId: command.runId,
      nodeName: command.nodeName,
      childKey: command.childKey,
      output: storedAttempt.output,
    })

    const snapshot = await input.store.loadRunSnapshot(command.runId)
    if (snapshot?.run.kind === 'task') {
      await input.store.completeNode({
        runId: command.runId,
        nodeName: command.nodeName,
        output: storedAttempt.output,
      })
      const completed = await input.store.completeRun({
        runId: command.runId,
        output: storedAttempt.output,
      })
      await wakeParentRun({
        store: input.store,
        runCoordinationExecutor: input.runCoordinationExecutor,
        run: completed,
      })
      await input.attemptExecutor.ack(input.claimed)
      return { status: 'processed' }
    }

    if (shouldCompleteNodeFromAttempt(command.childKey)) {
      await input.store.completeNode({
        runId: command.runId,
        nodeName: command.nodeName,
        output: storedAttempt.output,
      })
    }
    await enqueueContinueRun(input.runCoordinationExecutor, command)
    await input.attemptExecutor.ack(input.claimed)
    return { status: 'processed' }
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

    const snapshot = await input.store.loadRunSnapshot(command.runId)
    if (snapshot?.run.kind === 'task') {
      await input.store.failNode({
        runId: command.runId,
        nodeName: command.nodeName,
        error,
      })
      const failed = await input.store.failRun({
        runId: command.runId,
        error,
      })
      await wakeParentRun({
        store: input.store,
        runCoordinationExecutor: input.runCoordinationExecutor,
        run: failed,
      })
      await input.attemptExecutor.ack(input.claimed)
      return { status: 'processed' }
    }

    if (shouldCompleteNodeFromAttempt(command.childKey)) {
      await input.store.failNode({
        runId: command.runId,
        nodeName: command.nodeName,
        error,
      })
    }
    await enqueueContinueRun(input.runCoordinationExecutor, command)
    await input.attemptExecutor.ack(input.claimed)
    return { status: 'processed' }
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
  command: EnqueueContinueRunCommand,
): Promise<void> {
  await runCoordinationExecutor.enqueue({
    kind: 'continueRun',
    runId: command.runId,
    workflowName: command.workflowName,
  })
}
