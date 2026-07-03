import type {
  ActivityAttemptCommand,
  ClaimedAttempt,
  TaskAttemptCommand,
} from '../commands.ts'
import type { AttemptExecutor, RunCoordinationExecutor } from '../executors.ts'
import type { StoredAttempt, StoredNode } from '../state.ts'
import type { WorkflowStore } from '../store.ts'
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
  storedNode: StoredNode | undefined,
  storedAttempt: StoredAttempt | undefined,
): boolean {
  return (
    storedNode !== undefined &&
    isCurrentAttemptForNode(storedNode, command.attemptId) &&
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
  storedNode: StoredNode | undefined,
  storedAttempt: StoredAttempt | undefined,
): Promise<WorkerCommandResult> {
  const isCurrentAttempt = isCurrentAttemptForNode(
    storedNode,
    command.attemptId,
  )

  if (
    storedNode &&
    isCurrentAttempt &&
    storedAttempt?.status === 'completed' &&
    storedNode.status !== 'completed'
  ) {
    if (storedAttempt.runId === command.runId) {
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
    }

    if (!shouldCompleteNodeFromAttempt(storedNode)) {
      await enqueueContinueRun(input.runCoordinationExecutor, command)
      await input.attemptExecutor.ack(input.claimed)
      return { status: 'processed' }
    }

    await input.store.completeNode({
      runId: command.runId,
      nodeName: command.nodeName,
      output: storedAttempt.output,
    })
    await enqueueContinueRun(input.runCoordinationExecutor, command)
    await input.attemptExecutor.ack(input.claimed)
    return { status: 'processed' }
  }

  if (
    storedNode &&
    isCurrentAttempt &&
    storedAttempt?.status === 'failed' &&
    storedNode.status !== 'failed'
  ) {
    const snapshot = await input.store.loadRunSnapshot(command.runId)
    if (snapshot?.run.kind === 'task') {
      await input.store.failNode({
        runId: command.runId,
        nodeName: command.nodeName,
        error:
          storedAttempt.error ??
          new Error(`Workflow attempt [${command.attemptId}] failed`),
      })
      const failed = await input.store.failRun({
        runId: command.runId,
        error:
          storedAttempt.error ??
          new Error(`Workflow attempt [${command.attemptId}] failed`),
      })
      await wakeParentRun({
        store: input.store,
        runCoordinationExecutor: input.runCoordinationExecutor,
        run: failed,
      })
      await input.attemptExecutor.ack(input.claimed)
      return { status: 'processed' }
    }

    await input.store.failNode({
      runId: command.runId,
      nodeName: command.nodeName,
      error:
        storedAttempt.error ??
        new Error(`Workflow attempt [${command.attemptId}] failed`),
    })
    await enqueueContinueRun(input.runCoordinationExecutor, command)
    await input.attemptExecutor.ack(input.claimed)
    return { status: 'processed' }
  }

  if (
    storedNode &&
    storedAttempt &&
    ((storedAttempt.status === 'completed' &&
      storedNode.status === 'completed') ||
      (storedAttempt.status === 'failed' && storedNode.status === 'failed'))
  ) {
    await enqueueContinueRun(input.runCoordinationExecutor, command)
  }

  await input.attemptExecutor.ack(input.claimed)
  return { status: 'processed' }
}

export function shouldCompleteNodeFromAttempt(
  storedNode: StoredNode | undefined,
) {
  return storedNode?.kind !== 'parallel'
}

function isCurrentAttemptForNode(
  storedNode: StoredNode | undefined,
  attemptId: string,
) {
  if (!storedNode) return false
  if (storedNode.kind === 'parallel') return true
  return storedNode.currentAttemptId === attemptId
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
