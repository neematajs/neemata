import type { AnyWorkflowImplementation } from '../../implement/index.ts'
import type { RuntimeDeps } from '../executors.ts'
import type { RunSnapshot } from '../state.ts'
import type { RuntimeRunStatus } from '../status.ts'
import type { DeadWorkflowCommand } from '../store.ts'
import { continueRun } from '../commands.ts'
import { cancelRunTree } from '../coordinator/cancel.ts'
import { createRunLeaseFencedStore } from '../coordinator/continuation.ts'
import { failRunAndWakeParent } from '../coordinator/sinks.ts'
import { parseDurationMs } from '../duration.ts'
import { toStoredError } from '../errors.ts'
import { DEFAULT_LEASE_MS } from '../executors.ts'
import { isTerminalRunStatus } from '../status.ts'
import { shouldCompleteNodeFromAttempt } from './reconcile.ts'

/** The statuses a run can still be timed out from. */
const ACTIVE_RUN_STATUSES = [
  'queued',
  'running',
  'waiting',
  'cancelling',
] as const satisfies readonly RuntimeRunStatus[]

export type ReapDeadWorkflowCommandsInput = RuntimeDeps & {
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
    if (await reapDeadCommand(input, command)) reaped += 1
  }

  return { reaped }
}

async function reapDeadCommand(
  input: ReapDeadWorkflowCommandsInput,
  command: DeadWorkflowCommand,
): Promise<boolean> {
  const store = input.store
  const lease = await store.acquireRunLease({
    runId: command.runId,
    leaseMs: DEFAULT_LEASE_MS,
  })
  if (!lease) {
    // Another worker holds the run; only a run that no longer exists can be
    // retired without one.
    const [run] = await store.loadRuns([command.runId])
    if (run) return false
    await store.markDeadCommandReaped(command.id)
    return true
  }

  const scoped: ReapDeadWorkflowCommandsInput = {
    ...input,
    store: createRunLeaseFencedStore(store, lease, DEFAULT_LEASE_MS),
  }
  try {
    // Retry may have retired this command after the initial batch read.
    // Recheck under the run lease, without comparing different clock precisions.
    const [unreaped] = await scoped.store.listUnreapedDeadCommands({
      commandId: command.id,
    })
    if (!unreaped) return false

    const snapshot = await scoped.store.loadRunSnapshot(command.runId)
    if (!snapshot) {
      await scoped.store.markDeadCommandReaped(command.id)
      return true
    }
    const { run } = snapshot
    if (run.status === 'completed' || run.status === 'cancelled') {
      await scoped.store.markDeadCommandReaped(command.id)
      return true
    }

    const error =
      command.lastError ??
      toStoredError(
        new Error(`Workflow command [${command.id}] was dead-lettered`),
      )
    const { nodeName } = command

    if (
      (command.kind === 'activity' || command.kind === 'task') &&
      nodeName !== undefined
    ) {
      const childKey = attemptCommandChildKey(command)
      if (command.attemptId) {
        const child = snapshot.children.find(
          (candidate) =>
            candidate.nodeName === nodeName && candidate.childKey === childKey,
        )
        const attempt = snapshot.attempts.find(
          (candidate) => candidate.id === command.attemptId,
        )
        if (
          !child ||
          child.currentAttemptId !== command.attemptId ||
          attempt?.status === 'completed'
        ) {
          await scoped.store.markDeadCommandReaped(command.id)
          return true
        }
        if (attempt?.status === 'started' && attempt.leaseToken) {
          await scoped.store.failCurrentAttempt({
            attemptId: attempt.id,
            leaseToken: attempt.leaseToken,
            error,
          })
        }
      }
      if (childKey !== undefined) {
        await scoped.store.failNodeChild({
          runId: command.runId,
          nodeName,
          childKey,
          error,
        })
      }
      if (childKey === undefined || shouldCompleteNodeFromAttempt(childKey)) {
        await scoped.store.failNode({
          runId: command.runId,
          nodeName,
          error,
        })
      }
    }

    if (run.kind === 'task' || command.kind === 'continue') {
      // No coordination pass will run for this run, so cancel its live
      // descendants and nodes here — a failed run must not leave children
      // executing or nodes reporting running/waiting.
      await cancelDescendants(scoped, snapshot)
      await failRunAndWakeParent(scoped, { runId: command.runId, error })
    } else {
      // Workflow runs get a coordination pass: the coordinator sees the
      // failed node/child and fails the run after all fan-in siblings settle.
      await scoped.runCoordinationExecutor.enqueue(
        continueRun({
          id: command.runId,
          workflowName: command.workflowName ?? run.workflowName,
        }),
      )
    }

    await scoped.store.markDeadCommandReaped(command.id)
    return true
  } finally {
    await store.releaseRunLease(lease)
  }
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
  deps: RuntimeDeps,
  snapshot: RunSnapshot,
): Promise<void> {
  const runId = snapshot.run.id
  for (const child of snapshot.children) {
    if (child.childRunId === undefined) continue
    await cancelRunTree(deps, child.childRunId)
  }
  await deps.attemptExecutor.deleteUnclaimed({ runId })
  await deps.store.cancelNonTerminalRunNodes({ runId })
}

export type TimeoutExpiredWorkflowRunsInput = RuntimeDeps & {
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

    const expiredBefore = new Date(now.getTime() - timeoutMs)
    // Filtering by the current retry epoch in the store keeps the batch limit honest:
    // every returned run is already expired, so newer runs can never crowd
    // older expired ones out of the page.
    const { runs } = await input.store.listRuns({
      kind: 'workflow',
      name: implementation.workflow.name,
      status: ACTIVE_RUN_STATUSES,
      activeBefore: expiredBefore,
      limit: input.batchSize,
    })
    for (const candidate of runs) {
      if (
        await timeoutRun(input, candidate.id, expiredBefore, implementation)
      ) {
        timedOut += 1
      }
    }
  }

  return { timedOut }
}

async function timeoutRun(
  input: TimeoutExpiredWorkflowRunsInput,
  runId: string,
  expiredBefore: Date,
  implementation: AnyWorkflowImplementation,
): Promise<boolean> {
  const { store } = input
  const lease = await store.acquireRunLease({
    runId,
    leaseMs: DEFAULT_LEASE_MS,
  })
  if (!lease) return false

  const scoped: TimeoutExpiredWorkflowRunsInput = {
    ...input,
    store: createRunLeaseFencedStore(store, lease, DEFAULT_LEASE_MS),
  }
  try {
    const snapshot = await scoped.store.loadRunSnapshot(runId)
    if (!snapshot) return false
    const { run } = snapshot
    if (
      isTerminalRunStatus(run.status) ||
      run.activeSince.getTime() >= expiredBefore.getTime()
    ) {
      return false
    }

    await cancelDescendants(scoped, snapshot)
    await failRunAndWakeParent(scoped, {
      runId: run.id,
      error: new Error(
        `Workflow run [${run.id}] timed out after [${implementation.workflow.timeout}]`,
      ),
    })
    return true
  } finally {
    await store.releaseRunLease(lease)
  }
}
