import type { Container, DependencyContext } from '@nmtjs/core'

import type { AnyTaskImplementation } from '../../implement/index.ts'
import type { ClaimedAttempt } from '../commands.ts'
import type { RuntimeDeps } from '../executors.ts'
import type { WorkflowWakeEvents } from '../wake-events.ts'
import { decodeSchemaValue } from '../coordinator/codec.ts'
import { cancelRunAndWakeParent } from '../coordinator/sinks.ts'
import { parseDurationMs } from '../duration.ts'
import { createWorkflowRuntimeRegistry } from '../registry.ts'
import { isTerminalRunStatus } from '../status.ts'
import {
  runAtomicCompletion,
  type WorkflowRuntimeAtomicCompletion,
} from './atomic.ts'
import {
  isAttemptCancellationObserved,
  isAttemptShutdown,
  runWithAttemptHeartbeat,
} from './heartbeat.ts'
import { isAttemptHeartbeatLeaseLost } from './loop.ts'
import {
  ackTerminalAttempt,
  isFreshAttempt,
  loadAttemptState,
  reconcileStaleAttempt,
  releaseUnroutable,
  settleAttemptFailure,
  settleAttemptSuccess,
  type WorkerCommandResult,
} from './reconcile.ts'

export type RunTaskAttemptInput = RuntimeDeps & {
  readonly atomicCompletion?: WorkflowRuntimeAtomicCompletion
  readonly tasks: readonly AnyTaskImplementation[]
  readonly workerId: string
  readonly claimed: ClaimedAttempt
  readonly leaseMs?: number
  readonly signal?: AbortSignal
  readonly wakeEvents?: WorkflowWakeEvents
  readonly container: Pick<Container, 'createContext'>
}

export async function runTaskAttempt(
  input: RunTaskAttemptInput,
): Promise<WorkerCommandResult> {
  const command = input.claimed.command
  if (command.kind !== 'taskAttempt') {
    throw new Error(`Unsupported attempt command kind [${command.kind}]`)
  }

  const { snapshot, child, attempt } = await loadAttemptState(
    input.store,
    command,
  )
  const taskRun = snapshot?.run.kind === 'task'
  if (taskRun && snapshot.run.status === 'cancelling') {
    return await settleCancelledTaskRun(input)
  }
  if (snapshot && isTerminalRunStatus(snapshot.run.status)) {
    return await ackTerminalAttempt(input)
  }

  if (!isFreshAttempt(command, child, attempt)) {
    return await runAtomicCompletion(input, (scoped) =>
      reconcileStaleAttempt(scoped, command, child, attempt, taskRun),
    )
  }

  if (snapshot?.run.workflowName !== command.workflowName) {
    return await releaseUnroutable(
      input,
      `Run [${command.runId}] workflow does not match command workflow [${command.workflowName}]`,
    )
  }

  const registry = createWorkflowRuntimeRegistry({ tasks: input.tasks })
  const task = registry.getTask(command.taskName)
  if (!task) {
    return await releaseUnroutable(
      input,
      `No registered task implementation [${command.taskName}]`,
    )
  }

  // Task runs are advanced by workers, never by the coordinator, so this is
  // the queued → running transition for them.
  if (taskRun) {
    await input.store.markRunRunning({ runId: command.runId })
  }

  let output: unknown
  try {
    const timeoutMs = parseDurationMs(command.timeout ?? task.task.timeout)
    output = await runWithAttemptHeartbeat(
      { ...input, timeoutMs },
      async (lifecycle) => {
        const ctx = await input.container.createContext(task.dependencies)
        return await task.handler(
          ctx as DependencyContext<any>,
          command.input,
          lifecycle,
        )
      },
    )
    output = decodeSchemaValue(
      task.task.output,
      output,
      `task output [${task.task.name}]`,
    )
  } catch (error) {
    if (isAttemptHeartbeatLeaseLost(error) || isAttemptShutdown(error)) {
      throw error
    }
    if (isAttemptCancellationObserved(error)) {
      return taskRun
        ? await settleCancelledTaskRun(input)
        : await ackTerminalAttempt(input)
    }
    return await runAtomicCompletion(input, (scoped) =>
      settleAttemptFailure(scoped, {
        command,
        error,
        retry: task.task.retry,
        taskRun,
      }),
    )
  }

  return await runAtomicCompletion(input, (scoped) =>
    settleAttemptSuccess(scoped, { command, output, taskRun }),
  )
}

/**
 * Task runs have no coordinator to finish a requested cancellation, so the
 * worker that observes `cancelling` settles the run itself before dropping
 * the attempt. Idempotent against the client having already settled it: an
 * already-terminal run is left untouched.
 */
async function settleCancelledTaskRun(
  input: RunTaskAttemptInput,
): Promise<WorkerCommandResult> {
  const { runId } = input.claimed.command
  return await runAtomicCompletion(input, async (scoped) => {
    const [run] = await scoped.store.loadRuns([runId])
    if (run?.status === 'cancelling') {
      await cancelRunAndWakeParent(scoped, runId)
    }
    await scoped.attemptExecutor.ack(scoped.claimed)
    return { status: 'processed' }
  })
}
