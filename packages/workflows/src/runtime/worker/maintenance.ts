import type { WorkflowImplementation } from '../../implement/index.ts'
import type { AnyWorkflowDefinition } from '../../types/index.ts'
import type { AttemptExecutor, RunCoordinationExecutor } from '../executors.ts'
import type { DeadWorkflowCommand, WorkflowStore } from '../store.ts'
import { cancelRunTree } from '../coordinator/cancel.ts'
import { parseDurationMs } from '../duration.ts'
import { toStoredError } from '../errors.ts'
import { wakeParentRun } from '../wake.ts'
import { shouldCompleteNodeFromAttempt } from './reconcile.ts'

type AnyWorkflowImplementation = WorkflowImplementation<
  AnyWorkflowDefinition,
  any
>

export type ReapDeadWorkflowCommandsInput = {
  readonly store: WorkflowStore
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly batchSize?: number
}

export type ReapDeadWorkflowCommandsResult = {
  readonly reaped: number
}

/**
 * A dead-lettered command means its run can no longer make progress on its
 * own; without this sweep the run parks forever while only the dead-command
 * table knows why. Reaping gives it the same outcome the worker would have
 * produced on a final failure.
 */
export async function reapDeadWorkflowCommands(
  input: ReapDeadWorkflowCommandsInput,
): Promise<ReapDeadWorkflowCommandsResult> {
  const dead = await input.store.claimDeadCommands({
    limit: input.batchSize,
  })

  for (const command of dead) {
    const error =
      command.lastError ??
      toStoredError(
        new Error(`Workflow command [${command.id}] was dead-lettered`),
      )

    if (
      (command.kind === 'activity' || command.kind === 'task') &&
      command.nodeName !== undefined
    ) {
      const childKey = attemptCommandChildKey(command)
      if (childKey !== undefined) {
        await input.store.failNodeChild({
          runId: command.runId,
          nodeName: command.nodeName,
          childKey,
          error,
        })
      }
      if (childKey === undefined || shouldCompleteNodeFromAttempt(childKey)) {
        await input.store.failNode({
          runId: command.runId,
          nodeName: command.nodeName,
          error,
        })
      }
    }

    const run = (await input.store.loadRuns([command.runId]))[0]
    if (!run) continue

    if (run.kind === 'task' || command.kind === 'continue') {
      const failed = await input.store.failRun({
        runId: command.runId,
        error,
      })
      await wakeParentRun({
        store: input.store,
        runCoordinationExecutor: input.runCoordinationExecutor,
        run: failed,
      })
      continue
    }

    // Workflow runs get a coordination pass: the coordinator sees the failed
    // node/child and fails the run with fan-in sibling cancellation.
    await input.runCoordinationExecutor.enqueue({
      kind: 'continueRun',
      runId: command.runId,
      workflowName: command.workflowName ?? run.workflowName,
    })
  }

  return { reaped: dead.length }
}

function attemptCommandChildKey(
  command: DeadWorkflowCommand,
): string | undefined {
  const payload = command.payload
  if (payload && typeof payload === 'object' && 'childKey' in payload) {
    const childKey = (payload as { childKey?: unknown }).childKey
    return typeof childKey === 'string' ? childKey : undefined
  }
  return undefined
}

export type TimeoutExpiredWorkflowRunsInput = {
  readonly store: WorkflowStore
  readonly attemptExecutor: AttemptExecutor
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly workflows: readonly AnyWorkflowImplementation[]
  readonly batchSize?: number
  readonly now?: Date
}

export type TimeoutExpiredWorkflowRunsResult = {
  readonly timedOut: number
}

/**
 * Backstop for failure modes nothing else catches: any non-terminal run older
 * than its definition's `timeout` is failed and its descendants cancelled.
 */
export async function timeoutExpiredWorkflowRuns(
  input: TimeoutExpiredWorkflowRunsInput,
): Promise<TimeoutExpiredWorkflowRunsResult> {
  const now = input.now ?? new Date()
  let timedOut = 0

  for (const implementation of input.workflows) {
    const timeoutMs = parseDurationMs(implementation.workflow.timeout)
    if (timeoutMs === undefined) continue

    const { runs } = await input.store.listRuns({
      kind: 'workflow',
      name: implementation.workflow.name,
      status: ['queued', 'running', 'waiting'],
      limit: input.batchSize,
    })
    for (const run of runs) {
      if (run.createdAt.getTime() + timeoutMs > now.getTime()) continue

      const snapshot = await input.store.loadRunSnapshot(run.id)
      for (const child of snapshot?.children ?? []) {
        if (child.childRunId === undefined) continue
        await cancelRunTree({
          store: input.store,
          attemptExecutor: input.attemptExecutor,
          runCoordinationExecutor: input.runCoordinationExecutor,
          runId: child.childRunId,
        })
      }
      await input.attemptExecutor.deleteUnclaimed({ runId: run.id })
      await input.store.cancelNonTerminalRunNodes({ runId: run.id })
      const failed = await input.store.failRun({
        runId: run.id,
        error: new Error(
          `Workflow run [${run.id}] timed out after [${implementation.workflow.timeout}]`,
        ),
      })
      await wakeParentRun({
        store: input.store,
        runCoordinationExecutor: input.runCoordinationExecutor,
        run: failed,
      })
      timedOut += 1
    }
  }

  return { timedOut }
}
