import type {
  ActivityNodeImplementation,
  BranchNodeImplementation,
  ParallelNodeImplementation,
  WorkflowCaseImplementation,
  WorkflowImplementation,
} from '../../implement/index.ts'
import type {
  AnyWorkflowDefinition,
  BranchCaseDefinition,
  Schema,
} from '../../types/index.ts'
import type { ActivityAttemptCommand, ClaimedAttempt } from '../commands.ts'
import type { AttemptExecutor, RunCoordinationExecutor } from '../executors.ts'
import type { WorkflowStore } from '../store.ts'
import type { WorkflowWakeEvents } from '../wake-events.ts'
import { parseChildKey } from '../child-key.ts'
import { decodeStoredValue, encodeStoredValue } from '../codec.ts'
import { parseDurationMs } from '../duration.ts'
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
  shouldCompleteNodeFromAttempt,
  type WorkerCommandResult,
} from './reconcile.ts'
import { retryAttempt } from './retry.ts'

type ActivityAttemptNode =
  | ActivityNodeImplementation
  | Extract<WorkflowCaseImplementation, { readonly kind: 'activity' }>

type AnyWorkflowImplementation = WorkflowImplementation<
  AnyWorkflowDefinition,
  any
>

export type RunActivityAttemptInput = {
  readonly store: WorkflowStore
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly attemptExecutor: AttemptExecutor
  readonly atomicCompletion?: WorkflowRuntimeAtomicCompletion
  readonly workflows: readonly AnyWorkflowImplementation[]
  readonly workerId: string
  readonly claimed: ClaimedAttempt
  readonly leaseMs?: number
  readonly signal?: AbortSignal
  readonly wakeEvents?: WorkflowWakeEvents
  readonly handlers: HandlerRunner
  /** Passed to every handler; see `Env` in the implementation API. */
  readonly env?: unknown
}

export async function runActivityAttempt(
  input: RunActivityAttemptInput,
): Promise<WorkerCommandResult> {
  const command = input.claimed.command
  if (command.kind !== 'activityAttempt') {
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
  // A cancelling run is the coordinator's to settle. Running the handler here
  // would start new side effects after the cancellation was already observed.
  if (
    snapshot &&
    (snapshot.run.status === 'cancelling' ||
      isTerminalRunStatus(snapshot.run.status))
  ) {
    return await ackTerminalAttempt(input)
  }

  if (!isFreshAttempt(command, storedChild, storedAttempt)) {
    return await runAtomicCompletion(input, (scoped) =>
      reconcileStaleAttempt(scoped, command, storedChild, storedAttempt, {
        currentAttempt: snapshot?.attempts.find(
          (attempt) => attempt.id === storedChild?.currentAttemptId,
        ),
        resolveRetry: () => {
          const workflow = createWorkflowRuntimeRegistry({
            workflows: input.workflows,
          }).getWorkflow(command.workflowName) as
            | WorkflowImplementation
            | undefined
          return (
            workflow && resolveActivityAttemptNode(workflow, command)?.retry
          )
        },
      }),
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
    workflows: input.workflows,
  })
  const workflow = registry.getWorkflow(command.workflowName) as
    | WorkflowImplementation
    | undefined
  if (!workflow) {
    await input.attemptExecutor.release(input.claimed, {
      reason: 'unroutable',
      error: new Error(
        `No registered workflow implementation [${command.workflowName}]`,
      ),
    })
    return { status: 'released' }
  }

  const node = resolveActivityAttemptNode(workflow, command)
  if (!node) {
    await input.attemptExecutor.release(input.claimed, {
      reason: 'unroutable',
      error: new Error(
        `No activity implementation for [${command.workflowName}.${command.nodeName}.${command.childKey}]`,
      ),
    })
    return { status: 'released' }
  }

  let output: unknown
  try {
    const schemas = resolveActivityAttemptSchemas(workflow, command)
    if (!schemas)
      throw new Error(
        `Missing activity codecs [${command.workflowName}.${command.nodeName}.${command.childKey}]`,
      )
    const timeoutMs = resolveActivityAttemptTimeoutMs(workflow, command)
    output = await runWithAttemptHeartbeat(
      input,
      (lifecycle) =>
        input.handlers.run(
          () =>
            node.activity.handler(
              decodeStoredValue(
                schemas.input,
                command.input,
                `activity input [${schemas.label}]`,
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
      schemas.output,
      output,
      `activity output [${schemas.label}]`,
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
      return await ackTerminalAttempt(input)
    }
    return await runAtomicCompletion(input, async (scoped) => {
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
          retry: node.retry,
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

  return await runAtomicCompletion(input, async (scoped) => {
    const attempt = await scoped.store.completeCurrentAttempt({
      attemptId: command.attemptId,
      leaseToken: command.leaseToken,
      output,
    })
    if (!attempt) {
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
 * The command's childKey is authoritative: retries carry it, so member
 * resolution never depends on stored attempt bookkeeping.
 */
function resolveActivityAttemptNode(
  workflow: WorkflowImplementation,
  command: ActivityAttemptCommand,
): ActivityAttemptNode | undefined {
  const parsed = parseChildKey(command.childKey)
  if (!parsed) return undefined

  if (parsed.kind === 'self') {
    const direct = workflow.nodes.find(
      (candidate): candidate is ActivityNodeImplementation =>
        candidate.kind === 'activity' && candidate.name === command.nodeName,
    )
    if (!direct) return undefined
    return direct.activity.name === command.activityName ? direct : undefined
  }

  let selected: WorkflowCaseImplementation | undefined
  if (parsed.kind === 'case') {
    const branch = workflow.nodes.find(
      (candidate): candidate is BranchNodeImplementation =>
        candidate.kind === 'branch' && candidate.name === command.nodeName,
    )
    selected = branch?.cases[parsed.caseKey]
  }
  if (parsed.kind === 'member') {
    const parallel = workflow.nodes.find(
      (candidate): candidate is ParallelNodeImplementation =>
        candidate.kind === 'parallel' && candidate.name === command.nodeName,
    )
    selected = parallel?.cases[parsed.memberKey]
  }

  if (selected?.kind !== 'activity') return undefined

  return selected.activity.name === command.activityName ? selected : undefined
}

function resolveActivityAttemptCaseDeclaration(
  workflow: WorkflowImplementation,
  command: ActivityAttemptCommand,
): BranchCaseDefinition<'activity'> | undefined {
  const declaration = workflow.workflow.nodes.find(
    (candidate) => candidate.name === command.nodeName,
  )
  if (!declaration) return undefined
  if (declaration.kind !== 'branch' && declaration.kind !== 'parallel') {
    return undefined
  }

  const parsed = parseChildKey(command.childKey)
  const key =
    parsed?.kind === 'case'
      ? parsed.caseKey
      : parsed?.kind === 'member'
        ? parsed.memberKey
        : undefined
  const selected = key === undefined ? undefined : declaration.cases[key]
  if (selected?.kind !== 'activity') return undefined
  return selected as BranchCaseDefinition<'activity'>
}

function resolveActivityAttemptTimeoutMs(
  workflow: WorkflowImplementation,
  command: ActivityAttemptCommand,
): number | undefined {
  const declaration = workflow.workflow.nodes.find(
    (candidate) => candidate.name === command.nodeName,
  )
  if (!declaration) return undefined
  if (declaration.kind === 'activity')
    return parseDurationMs(declaration.timeout)
  const caseDeclaration = resolveActivityAttemptCaseDeclaration(
    workflow,
    command,
  )
  return caseDeclaration ? parseDurationMs(caseDeclaration.timeout) : undefined
}

function resolveActivityAttemptSchemas(
  workflow: WorkflowImplementation,
  command: ActivityAttemptCommand,
):
  | { readonly input: Schema; readonly output: Schema; readonly label: string }
  | undefined {
  const declaration = workflow.workflow.nodes.find(
    (candidate) => candidate.name === command.nodeName,
  )
  if (!declaration) return undefined
  if (declaration.kind === 'activity') {
    return {
      input: declaration.input,
      output: declaration.output,
      label: `${workflow.workflow.name}.${command.nodeName}`,
    }
  }
  const caseDeclaration = resolveActivityAttemptCaseDeclaration(
    workflow,
    command,
  )
  if (!caseDeclaration) return undefined
  return {
    input: caseDeclaration.input,
    output: caseDeclaration.output,
    label: `${workflow.workflow.name}.${command.nodeName}.${command.childKey}`,
  }
}
