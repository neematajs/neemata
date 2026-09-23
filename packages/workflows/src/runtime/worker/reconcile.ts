import type { RetryPolicy } from '../../types/index.ts'
import type {
  ActivityAttemptCommand,
  ClaimedAttempt,
  TaskAttemptCommand,
} from '../commands.ts'
import type { AttemptExecutor, RunCoordinationExecutor } from '../executors.ts'
import type { StoredAttempt, StoredNodeChild, StoredRun } from '../state.ts'
import type { WorkflowStore } from '../store.ts'
import { parseChildKey } from '../child-key.ts'
import { withAttemptExecutorFence, withWriteFence } from '../fence.ts'
import { isTerminalNodeStatus } from '../status.ts'
import { wakeParentRun } from '../wake.ts'
import { runAtomicCompletion } from './atomic.ts'
import { redispatchRetry, retryAttempt } from './retry.ts'

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

type ReplayAttemptInput = Pick<
  RunAttemptInput,
  'store' | 'runCoordinationExecutor' | 'attemptExecutor'
>

type AttemptRecovery = {
  /** The attempt `child.currentAttemptId` points at. */
  readonly currentAttempt: StoredAttempt | undefined
  /** Lazy: resolving the policy needs the registry, which most redeliveries never touch. */
  readonly resolveRetry: () => RetryPolicy | undefined
}

/**
 * Writes made for an attempt's outcome hold only while it is still its child's
 * current attempt. Replays by a new claimant or the reaper keep holding it; a
 * worker that stalled past a manual retry reopening the child does not.
 */
export function scopeToAttempt<Input extends ReplayAttemptInput>(
  input: Input,
  command: Pick<
    EnqueueContinueRunCommand,
    'runId' | 'nodeName' | 'childKey' | 'attemptId'
  >,
): Input {
  const scope = {
    fence: {
      attempt: {
        runId: command.runId,
        nodeName: command.nodeName,
        childKey: command.childKey,
        attemptId: command.attemptId,
      },
    },
  }
  return {
    ...input,
    store: withWriteFence(input.store, scope),
    attemptExecutor: withAttemptExecutorFence(input.attemptExecutor, scope),
  }
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

/**
 * A task run settles itself, so its attempt command is the only durable
 * trigger for the parent wake: a worker lost between terminalizing the run
 * and waking the parent leaves nothing else to replay it. The wake is
 * idempotent, so every terminal redelivery repeats it before acknowledging.
 */
export async function ackTerminalAttempt<Input extends RunAttemptInput>(
  input: Input,
  terminalTaskRun?: StoredRun,
): Promise<WorkerCommandResult> {
  return await runAtomicCompletion(input, async (scoped) => {
    await wakeParentRun({
      store: scoped.store,
      runCoordinationExecutor: scoped.runCoordinationExecutor,
      run: terminalTaskRun,
    })
    await scoped.attemptExecutor.ack(scoped.claimed)
    return { status: 'processed' }
  })
}

export async function reconcileStaleAttempt<Input extends RunAttemptInput>(
  input: Input,
  command: EnqueueContinueRunCommand,
  child: StoredNodeChild | undefined,
  storedAttempt: StoredAttempt | undefined,
  recovery: AttemptRecovery,
): Promise<WorkerCommandResult> {
  const isCurrentAttempt = child?.currentAttemptId === command.attemptId

  if (child && isCurrentAttempt && storedAttempt?.status === 'completed') {
    await replayCompletedAttempt(input, command, storedAttempt)
    await input.attemptExecutor.ack(input.claimed)
    return { status: 'processed' }
  }

  if (
    child &&
    isCurrentAttempt &&
    isFailedAttemptStatus(storedAttempt?.status)
  ) {
    // The attempt settled but the worker died before spending the retry
    // budget; failing the child here would silently drop the remaining tries.
    if (
      storedAttempt &&
      !isTerminalNodeStatus(child.status) &&
      (await retryAttempt(input, {
        command,
        failedAttempt: storedAttempt,
        retry: recovery.resolveRetry(),
      }))
    ) {
      await input.attemptExecutor.ack(input.claimed)
      return { status: 'processed' }
    }

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

  await replaySupersededAttempt(input, command, child, storedAttempt, recovery)
  await input.attemptExecutor.ack(input.claimed)
  return { status: 'processed' }
}

/**
 * Downstream writes are idempotent, so a settled current attempt always
 * replays its full completion path: a crash after any single write (child,
 * node, run) is repaired by whoever sees the command next. Never acknowledges:
 * the reaper replays this without a queue claim.
 */
export async function replayCompletedAttempt(
  input: ReplayAttemptInput,
  command: EnqueueContinueRunCommand,
  storedAttempt: StoredAttempt,
): Promise<void> {
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
    return
  }

  if (shouldCompleteNodeFromAttempt(command.childKey)) {
    await input.store.completeNode({
      runId: command.runId,
      nodeName: command.nodeName,
      output: storedAttempt.output,
    })
  }
  await enqueueContinueRun(input.runCoordinationExecutor, command)
}

/**
 * The command of an attempt that is no longer the child's current one. Like
 * `replayCompletedAttempt`, shared with the reaper and never acknowledges.
 */
export async function replaySupersededAttempt(
  input: ReplayAttemptInput,
  command: EnqueueContinueRunCommand,
  child: StoredNodeChild | undefined,
  storedAttempt: StoredAttempt | undefined,
  recovery: AttemptRecovery,
): Promise<void> {
  // Without `atomicCompletion` a retry is two writes: the next attempt, then
  // its command. This superseded command outliving both means the second write
  // may be missing, which would leave the run `running` with nothing queued.
  const { currentAttempt } = recovery
  if (
    child &&
    storedAttempt &&
    isFailedAttemptStatus(storedAttempt.status) &&
    currentAttempt !== undefined &&
    currentAttempt.id === child.currentAttemptId &&
    currentAttempt.status === 'started' &&
    currentAttempt.attemptNumber === storedAttempt.attemptNumber + 1
  ) {
    await redispatchRetry(input, {
      command,
      failedAttempt: storedAttempt,
      attempt: currentAttempt,
      retry: recovery.resolveRetry(),
    })
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
