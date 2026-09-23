import type {
  TaskImplementation,
  WorkflowImplementation,
} from '../../implement/index.ts'
import type {
  AnyTaskDefinition,
  AnyWorkflowDefinition,
  Timestamp,
} from '../../types/index.ts'
import type { AttemptCommand } from '../commands.ts'
import type { AttemptExecutor, RunCoordinationExecutor } from '../executors.ts'
import type { DeadWorkflowCommand, WorkflowStore } from '../store.ts'
import { cancelRunDescendants } from '../coordinator/cancel.ts'
import { createRunLeaseScope, isRunLeaseLost } from '../coordinator/lease.ts'
import { parseDurationMs } from '../duration.ts'
import { toStoredError } from '../errors.ts'
import { createWorkflowRuntimeRegistry } from '../registry.ts'
import { wakeParentRun } from '../wake.ts'
import { resolveActivityAttemptRetry } from './activity-attempt.ts'
import {
  replayCompletedAttempt,
  replaySupersededAttempt,
  scopeToAttempt,
  shouldCompleteNodeFromAttempt,
} from './reconcile.ts'

type AnyWorkflowImplementation = WorkflowImplementation<
  AnyWorkflowDefinition,
  any
>
type AnyTaskImplementation = TaskImplementation<AnyTaskDefinition, any>

export type ReapDeadWorkflowCommandsInput = {
  readonly store: WorkflowStore
  readonly attemptExecutor: AttemptExecutor
  readonly runCoordinationExecutor: RunCoordinationExecutor
  /** Resolve the retry policy, and so the backoff, of a lost retry. */
  readonly workflows: readonly AnyWorkflowImplementation[]
  /** A task run started outside a workflow carries no policy in its command. */
  readonly tasks?: readonly AnyTaskImplementation[]
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

  const registry = createWorkflowRuntimeRegistry({
    workflows: input.workflows,
    tasks: input.tasks,
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
    const scopedInput = createRunLeaseScope(input, lease, 30_000)
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
        // The dead command may have been the only durable trigger of the
        // parent wake; no redelivery is left to replay it.
        await wakeParentRun({
          store: scopedInput.store,
          runCoordinationExecutor: scopedInput.runCoordinationExecutor,
          run,
        })
        await scopedInput.store.markDeadCommandReaped(command.id)
        reaped += 1
        continue
      }
      const error =
        command.lastError ??
        toStoredError(
          new Error(`Workflow command [${command.id}] was dead-lettered`),
        )

      // Failing the current attempt holds only while it stays current: a
      // worker that outlived its claim can still create a retry meanwhile.
      let failing = scopedInput
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
          const isCurrentAttempt = child?.currentAttemptId === command.attemptId
          // A settled or superseded attempt is not this command's to fail, but
          // the worker may have died between its writes. With the delivery
          // budget spent, this is the last chance to replay what a redelivery
          // would have repaired.
          if (!child || !isCurrentAttempt || attempt?.status === 'completed') {
            const attemptCommand = deadAttemptCommand(command)
            if (child && attempt && attemptCommand) {
              if (isCurrentAttempt) {
                await replayCompletedAttempt(
                  scopeToAttempt(scopedInput, attemptCommand),
                  attemptCommand,
                  attempt,
                )
              } else {
                await replaySupersededAttempt(
                  scopedInput,
                  attemptCommand,
                  child,
                  attempt,
                  {
                    currentAttempt: snapshot?.attempts.find(
                      (attempt) => attempt.id === child.currentAttemptId,
                    ),
                    resolveRetry: () =>
                      attemptCommand.kind === 'taskAttempt'
                        ? (attemptCommand.retry ??
                          registry.getTask(attemptCommand.taskName)?.task.retry)
                        : resolveActivityAttemptRetry(registry, attemptCommand),
                  },
                )
              }
            }
            await scopedInput.store.markDeadCommandReaped(command.id)
            reaped += 1
            continue
          }
          if (childKey !== undefined) {
            failing = scopeToAttempt(scopedInput, {
              runId: command.runId,
              nodeName: command.nodeName,
              childKey,
              attemptId: command.attemptId,
            })
          }
          if (attempt?.status === 'started' && attempt.leaseToken) {
            await failing.store.failCurrentAttempt({
              attemptId: attempt.id,
              leaseToken: attempt.leaseToken,
              error,
            })
          }
        }
        if (childKey !== undefined) {
          await failing.store.failNodeChild({
            runId: command.runId,
            nodeName: command.nodeName,
            childKey,
            error,
          })
        }
        if (childKey === undefined || shouldCompleteNodeFromAttempt(childKey)) {
          await failing.store.failNode({
            runId: command.runId,
            nodeName: command.nodeName,
            error,
          })
        }
      }

      if (run.kind === 'task' || command.kind === 'continue') {
        // No coordination pass will run for this run, so cancel its live
        // descendants and nodes here.
        await cancelRunDescendants({ ...failing, snapshot: snapshot! })
        const failed = await failing.store.failRun({
          runId: command.runId,
          error,
        })
        await wakeParentRun({
          store: failing.store,
          runCoordinationExecutor: failing.runCoordinationExecutor,
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
    } catch (error) {
      // Left unreaped: the next sweep reacquires the lease and reloads.
      if (!isRunLeaseLost(error)) throw error
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

/** Every adapter dead-letters the command it was given, unchanged. */
function deadAttemptCommand(
  command: DeadWorkflowCommand,
): AttemptCommand | undefined {
  const payload = command.payload as Partial<AttemptCommand> | null | undefined
  return (payload?.kind === 'activityAttempt' ||
    payload?.kind === 'taskAttempt') &&
    attemptCommandChildKey(command) !== undefined
    ? (payload as AttemptCommand)
    : undefined
}

export type TimeoutExpiredWorkflowRunsInput = {
  readonly store: WorkflowStore
  readonly attemptExecutor: AttemptExecutor
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly workflows: readonly AnyWorkflowImplementation[]
  readonly batchSize?: number
  readonly now?: Timestamp
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
  const now = input.now ?? Date.now()
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
      activeBefore: now - timeoutMs,
      limit: input.batchSize,
    })
    for (const candidate of runs) {
      const lease = await input.store.acquireRunLease({
        runId: candidate.id,
        leaseMs: 30_000,
      })
      if (!lease) continue
      const scoped = createRunLeaseScope(input, lease, 30_000)
      try {
        const snapshot = await scoped.store.loadRunSnapshot(candidate.id)
        const run = snapshot?.run
        if (
          !run ||
          !['queued', 'running', 'waiting', 'cancelling'].includes(
            run.status,
          ) ||
          run.activeSince >= now - timeoutMs
        )
          continue
        // The writes below are separate, and a later sweep skips a terminal
        // run. The run's own continuation is the durable intent: it cannot
        // pass while this lease is held, and a pass over a failed run replays
        // the descendant cancellation and the parent wake until they land.
        await input.runCoordinationExecutor.enqueue({
          kind: 'continueRun',
          runId: run.id,
          workflowName: run.workflowName,
        })
        // Failing first keeps the timeout error: were the nodes cancelled
        // before a lost `failRun`, that continuation would cancel the run.
        const failed = await scoped.store.failRun({
          runId: run.id,
          error: new Error(
            `Workflow run [${run.id}] timed out after [${implementation.workflow.timeout}]`,
          ),
        })
        await cancelRunDescendants({ ...scoped, snapshot: snapshot! })
        await wakeParentRun({
          store: scoped.store,
          runCoordinationExecutor: input.runCoordinationExecutor,
          run: failed,
        })
        timedOut += 1
      } catch (error) {
        // The enqueued continuation, or the next sweep, finishes the run.
        if (!isRunLeaseLost(error)) throw error
      } finally {
        await input.store.releaseRunLease(lease)
      }
    }
  }

  return { timedOut }
}
