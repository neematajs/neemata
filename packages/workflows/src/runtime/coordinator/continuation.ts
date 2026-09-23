import type * as Context from 'effect/Context'

import type { WorkflowImplementation } from '../../implement/index.ts'
import type { AnyWorkflowDefinition } from '../../types/index.ts'
import type { ContinueRunCommand } from '../commands.ts'
import type { AttemptExecutor, RunCoordinationExecutor } from '../executors.ts'
import type { RunLease, WorkflowStore } from '../store.ts'
import { decodeStoredValue, decodeNodeOutput } from '../codec.ts'
import {
  createHandlerRuntime,
  WorkflowCleanupTimeoutError,
  type HandlerRuntime,
  type HandlerRuntimeOptions,
} from '../handler.ts'
import { createWorkflowRuntimeRegistry } from '../registry.ts'
import { isTerminalRunStatus } from '../status.ts'
import { wakeParentRun } from '../wake.ts'
import { advanceWorkflowRun } from './advance.ts'
import { getWorkflowNodeDeclaration } from './codec.ts'
import { cancelRunAndWakeParent, failRunAndWakeParent } from './sinks.ts'

class StaleRunLeaseError extends Error {
  constructor() {
    super('Stale workflow run lease')
    this.name = 'StaleRunLeaseError'
  }
}

export type ContinueWorkflowRunInput = HandlerRuntimeOptions & {
  readonly signal?: AbortSignal
  readonly store: WorkflowStore
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly attemptExecutor: AttemptExecutor
  readonly context: Context.Context<never>
  readonly handlers?: HandlerRuntime
  readonly workflows: readonly WorkflowImplementation<
    AnyWorkflowDefinition,
    any
  >[]
  readonly workerId: string
  readonly command: ContinueRunCommand
  readonly leaseMs?: number
}

export type ContinueWorkflowRunResult = {
  readonly status: 'processed' | 'busy' | 'ignored'
}

export async function continueWorkflowRun(
  input: ContinueWorkflowRunInput,
): Promise<ContinueWorkflowRunResult> {
  const registry = createWorkflowRuntimeRegistry({
    workflows: input.workflows,
  })
  const implementation = registry.getWorkflow(input.command.workflowName) as
    | WorkflowImplementation
    | undefined
  if (!implementation) return { status: 'ignored' }

  const leaseMs = input.leaseMs ?? 30_000
  const lease = await input.store.acquireRunLease({
    runId: input.command.runId,
    leaseMs,
  })
  if (!lease) return { status: 'busy' }

  try {
    return await runWithRunLeaseRenewal(
      input.store,
      lease,
      leaseMs,
      input.signal,
      async (signal): Promise<ContinueWorkflowRunResult> => {
        const store = createRunLeaseFencedStore(
          input.store,
          lease,
          leaseMs,
          signal,
        )
        const snapshot = await store.loadRunSnapshot(input.command.runId)
        if (!snapshot) return { status: 'ignored' }
        if (snapshot.run.workflowName !== input.command.workflowName) {
          return { status: 'ignored' }
        }
        if (snapshot.run.status === 'cancelling') {
          await cancelRunAndWakeParent({
            store,
            attemptExecutor: input.attemptExecutor,
            runCoordinationExecutor: input.runCoordinationExecutor,
            runId: snapshot.run.id,
          })
          return { status: 'processed' }
        }
        if (isTerminalRunStatus(snapshot.run.status)) {
          await wakeParentRun({
            store,
            runCoordinationExecutor: input.runCoordinationExecutor,
            run: snapshot.run,
          })
          return { status: 'processed' }
        }

        const failedNode = snapshot.nodes.find(
          (node) => node.status === 'failed',
        )
        if (failedNode) {
          await failRunAndWakeParent({
            store,
            runCoordinationExecutor: input.runCoordinationExecutor,
            runId: snapshot.run.id,
            error:
              failedNode.error ??
              new Error(`Workflow node [${failedNode.name}] failed`),
          })
          return { status: 'processed' }
        }

        if (snapshot.nodes.some((node) => node.status === 'cancelled')) {
          await cancelRunAndWakeParent({
            store,
            attemptExecutor: input.attemptExecutor,
            runCoordinationExecutor: input.runCoordinationExecutor,
            runId: snapshot.run.id,
          })
          return { status: 'processed' }
        }

        const outputs: Record<string, unknown> = {}
        let workflowInput: unknown
        try {
          workflowInput = decodeStoredValue(
            implementation.workflow.input,
            snapshot.run.input,
            `workflow input [${implementation.workflow.name}]`,
          )
          for (const node of snapshot.nodes) {
            if (node.status !== 'completed') continue
            outputs[node.name] = decodeNodeOutput(
              getWorkflowNodeDeclaration(implementation, node.name),
              node.output,
              node.selectedCase,
            )
          }
        } catch (error) {
          await failRunAndWakeParent({
            store,
            runCoordinationExecutor: input.runCoordinationExecutor,
            runId: snapshot.run.id,
            error,
          })
          return { status: 'processed' }
        }

        // The run has coordination work from here on; queued/waiting → running
        // before dispatching so status filters see live runs as such.
        await store.markRunRunning({ runId: snapshot.run.id })

        const outcome = await advanceWorkflowRun({
          store,
          attemptExecutor: input.attemptExecutor,
          runCoordinationExecutor: input.runCoordinationExecutor,
          workflow: implementation,
          signal,
          handlers:
            input.handlers ?? createHandlerRuntime(input.context, input),
          run: snapshot.run,
          workflowInput,
          outputs,
          advance: advanceWorkflowRun,
        })
        if (outcome === 'parked') {
          await store.markRunWaiting({ runId: snapshot.run.id })
        }
        return { status: 'processed' }
      },
    ).catch((error: unknown) => {
      if (error instanceof WorkflowCleanupTimeoutError) throw error
      if (
        error instanceof StaleRunLeaseError ||
        error instanceof CancelledRunError ||
        input.signal?.aborted
      ) {
        return { status: 'busy' } satisfies ContinueWorkflowRunResult
      }
      throw error
    })
  } finally {
    await input.store.releaseRunLease(lease)
  }
}

export function createRunLeaseFencedStore(
  store: WorkflowStore,
  lease: RunLease,
  leaseMs: number,
  signal?: AbortSignal,
): WorkflowStore {
  const fence = async <T>(operation: () => Promise<T>): Promise<T> => {
    signal?.throwIfAborted()
    const renewedLease = await store.renewRunLease(lease, leaseMs)
    if (!renewedLease) throw new StaleRunLeaseError()
    signal?.throwIfAborted()
    return operation()
  }

  return {
    ...store,
    createRun: (params) => fence(() => store.createRun(params)),
    createNode: (params) => fence(() => store.createNode(params)),
    setNodeInput: (params) => fence(() => store.setNodeInput(params)),
    createAttempt: (params) => fence(() => store.createAttempt(params)),
    completeCurrentAttempt: (params) =>
      fence(() => store.completeCurrentAttempt(params)),
    failCurrentAttempt: (params) =>
      fence(() => store.failCurrentAttempt(params)),
    completeNode: (params) => fence(() => store.completeNode(params)),
    failNode: (params) => fence(() => store.failNode(params)),
    markRunRunning: (params) => fence(() => store.markRunRunning(params)),
    markRunWaiting: (params) => fence(() => store.markRunWaiting(params)),
    completeRun: (params) => fence(() => store.completeRun(params)),
    failRun: (params) => fence(() => store.failRun(params)),
    requestRunCancellation: (params) =>
      fence(() => store.requestRunCancellation(params)),
    cancelRun: (params) => fence(() => store.cancelRun(params)),
    cancelNode: (params) => fence(() => store.cancelNode(params)),
    cancelNonTerminalRunNodes: (params) =>
      fence(() => store.cancelNonTerminalRunNodes(params)),
    ensureNodeChildren: (params) =>
      fence(() => store.ensureNodeChildren(params)),
    ensureChildRun: (params) => fence(() => store.ensureChildRun(params)),
    ensureChildAttempt: (params) =>
      fence(() => store.ensureChildAttempt(params)),
    selectNodeCase: (params) => fence(() => store.selectNodeCase(params)),
    completeNodeChild: (params) => fence(() => store.completeNodeChild(params)),
    failNodeChild: (params) => fence(() => store.failNodeChild(params)),
    waitNode: (params) => fence(() => store.waitNode(params)),
  }
}

class CancelledRunError extends Error {
  constructor() {
    super('Workflow run cancellation observed during coordination')
    this.name = 'CancelledRunError'
  }
}

async function runWithRunLeaseRenewal<T>(
  store: WorkflowStore,
  lease: RunLease,
  leaseMs: number,
  signal: AbortSignal | undefined,
  handler: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const abort = new AbortController()
  const shutdown = () => abort.abort(signal?.reason)
  if (signal?.aborted) shutdown()
  else signal?.addEventListener('abort', shutdown, { once: true })
  let renewing: Promise<void> | undefined
  const interval = setInterval(
    () => {
      if (renewing || abort.signal.aborted) return
      renewing = (async () => {
        if (!(await store.renewRunLease(lease, leaseMs))) {
          abort.abort(new StaleRunLeaseError())
          return
        }
        // finish is user Effect work now; a long-running finish must observe
        // cancellation just like an activity, without allowing a late commit.
        const [run] = await store.loadRuns([lease.runId])
        if (
          run &&
          (run.status === 'cancelling' || isTerminalRunStatus(run.status))
        ) {
          abort.abort(new CancelledRunError())
        }
      })()
        .catch(() => {
          // Transient renewal errors retain the existing behavior: every write
          // still checks ownership through the fenced store before committing.
        })
        .finally(() => {
          renewing = undefined
        })
    },
    Math.max(1, Math.floor(leaseMs / 3)),
  )
  try {
    abort.signal.throwIfAborted()
    return await handler(abort.signal)
  } finally {
    clearInterval(interval)
    signal?.removeEventListener('abort', shutdown)
    await renewing
  }
}
