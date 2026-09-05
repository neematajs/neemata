import type { WorkflowImplementation } from '../../implement/index.ts'
import type { AnyWorkflowDefinition } from '../../types/index.ts'
import type { AttemptExecutor, RunCoordinationExecutor } from '../executors.ts'
import type { RunSnapshot } from '../state.ts'
import type { DeadWorkflowCommand, WorkflowStore } from '../store.ts'
import { cancelRunTree } from '../coordinator/cancel.ts'
import { createRunLeaseFencedStore } from '../coordinator/continuation.ts'
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
  readonly attemptExecutor: AttemptExecutor
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
 * produced on a final failure. Each command is marked reaped only AFTER its
 * outcome is produced — a crash mid-batch re-lists the remainder, and the
 * recovery writes are idempotent so duplicate processing is harmless.
 */
export async function reapDeadWorkflowCommands(
  input: ReapDeadWorkflowCommandsInput,
): Promise<ReapDeadWorkflowCommandsResult> {
  const dead = await input.store.listUnreapedDeadCommands({
    limit: input.batchSize,
  })

  let reaped = 0
  for (const command of dead) {
    const lease = await input.store.acquireRunLease({
      runId: command.runId,
      leaseMs: 30_000,
    })
    if (!lease) {
      if (!(await input.store.loadRuns([command.runId])).length) {
        await input.store.markDeadCommandReaped(command.id)
        reaped += 1
      }
      continue
    }
    const originalStore = input.store
    const scopedInput = {
      ...input,
      store: createRunLeaseFencedStore(originalStore, lease, 30_000),
    }
    try {
      // Retry may have retired this command after the initial batch read.
      // Recheck under the run lease, without comparing different clock precisions.
      if (
        !(
          await scopedInput.store.listUnreapedDeadCommands({
            commandId: command.id,
          })
        ).length
      )
        continue
      const snapshot = await scopedInput.store.loadRunSnapshot(command.runId)
      const run = snapshot?.run
      if (!run || ['completed', 'cancelled'].includes(run.status)) {
        await scopedInput.store.markDeadCommandReaped(command.id)
        reaped += 1
        continue
      }
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
        if (command.attemptId) {
          const child = snapshot?.children.find(
            (child) =>
              child.nodeName === command.nodeName &&
              child.childKey === childKey,
          )
          const attempt = snapshot?.attempts.find(
            (attempt) => attempt.id === command.attemptId,
          )
          if (
            !child ||
            child.currentAttemptId !== command.attemptId ||
            attempt?.status === 'completed'
          ) {
            await scopedInput.store.markDeadCommandReaped(command.id)
            reaped += 1
            continue
          }
          if (attempt?.status === 'started' && attempt.leaseToken) {
            await scopedInput.store.failCurrentAttempt({
              attemptId: attempt.id,
              leaseToken: attempt.leaseToken,
              error,
            })
          }
        }
        if (childKey !== undefined) {
          await scopedInput.store.failNodeChild({
            runId: command.runId,
            nodeName: command.nodeName,
            childKey,
            error,
          })
        }
        if (childKey === undefined || shouldCompleteNodeFromAttempt(childKey)) {
          await scopedInput.store.failNode({
            runId: command.runId,
            nodeName: command.nodeName,
            error,
          })
        }
      }

      if (run.kind === 'task' || command.kind === 'continue') {
        // No coordination pass will run for this run, so cancel its live
        // descendants and nodes here — a failed run must not leave children
        // executing or nodes reporting running/waiting.
        await cancelDescendants(scopedInput, snapshot!)
        const failed = await scopedInput.store.failRun({
          runId: command.runId,
          error,
        })
        await wakeParentRun({
          store: scopedInput.store,
          runCoordinationExecutor: scopedInput.runCoordinationExecutor,
          run: failed,
        })
      } else {
        // Workflow runs get a coordination pass: the coordinator sees the
        // failed node/child and fails the run after all fan-in siblings settle.
        await scopedInput.runCoordinationExecutor.enqueue({
          kind: 'continueRun',
          runId: command.runId,
          workflowName: command.workflowName ?? run.workflowName,
        })
      }

      await scopedInput.store.markDeadCommandReaped(command.id)
      reaped += 1
    } finally {
      await originalStore.releaseRunLease(lease)
    }
  }

  return { reaped }
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

async function cancelDescendants(
  input: Pick<
    ReapDeadWorkflowCommandsInput,
    'store' | 'attemptExecutor' | 'runCoordinationExecutor'
  >,
  snapshot: RunSnapshot,
): Promise<void> {
  const runId = snapshot.run.id
  for (const child of snapshot.children) {
    if (child.childRunId === undefined) continue
    await cancelRunTree({
      store: input.store,
      attemptExecutor: input.attemptExecutor,
      runCoordinationExecutor: input.runCoordinationExecutor,
      runId: child.childRunId,
    })
  }
  await input.attemptExecutor.deleteUnclaimed({ runId })
  await input.store.cancelNonTerminalRunNodes({ runId })
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

    // Filtering by the current retry epoch in the store keeps the batch limit honest:
    // every returned run is already expired, so newer runs can never crowd
    // older expired ones out of the page.
    const { runs } = await input.store.listRuns({
      kind: 'workflow',
      name: implementation.workflow.name,
      status: ['queued', 'running', 'waiting', 'cancelling'],
      activeBefore: new Date(now.getTime() - timeoutMs),
      limit: input.batchSize,
    })
    for (const candidate of runs) {
      const lease = await input.store.acquireRunLease({
        runId: candidate.id,
        leaseMs: 30_000,
      })
      if (!lease) continue
      const scoped = {
        ...input,
        store: createRunLeaseFencedStore(input.store, lease, 30_000),
      }
      try {
        const snapshot = await scoped.store.loadRunSnapshot(candidate.id)
        const run = snapshot?.run
        if (
          !run ||
          !['queued', 'running', 'waiting', 'cancelling'].includes(
            run.status,
          ) ||
          run.activeSince.getTime() >= now.getTime() - timeoutMs
        )
          continue
        await cancelDescendants(scoped, snapshot!)
        const failed = await scoped.store.failRun({
          runId: run.id,
          error: new Error(
            `Workflow run [${run.id}] timed out after [${implementation.workflow.timeout}]`,
          ),
        })
        await wakeParentRun({
          store: scoped.store,
          runCoordinationExecutor: input.runCoordinationExecutor,
          run: failed,
        })
        timedOut += 1
      } finally {
        await input.store.releaseRunLease(lease)
      }
    }
  }

  return { timedOut }
}
