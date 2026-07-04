import type { Container, DependencyContext } from '@nmtjs/core'

import type { WorkflowImplementation } from '../../implement/index.ts'
import type { AnyWorkflowDefinition } from '../../types/index.ts'
import type { ContinueRunCommand } from '../commands.ts'
import type { AttemptExecutor, RunCoordinationExecutor } from '../executors.ts'
import type { RunLease, WorkflowStore } from '../store.ts'
import { createWorkflowRuntimeRegistry } from '../registry.ts'
import { isTerminalRunStatus } from '../status.ts'
import { wakeParentRun } from '../wake.ts'
import { advanceWorkflowRun } from './advance.ts'
import { cancelFailedFanInNodeChildren } from './cancel.ts'
import { cancelRunAndWakeParent, failRunAndWakeParent } from './sinks.ts'

class StaleRunLeaseError extends Error {
  constructor() {
    super('Stale workflow run lease')
    this.name = 'StaleRunLeaseError'
  }
}

export type ContinueWorkflowRunInput = {
  readonly store: WorkflowStore
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly attemptExecutor: AttemptExecutor
  readonly container: Pick<Container, 'createContext'>
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
  const store = createRunLeaseFencedStore(input.store, lease, leaseMs)

  try {
    return await runWithRunLeaseRenewal(
      input.store,
      lease,
      leaseMs,
      async (): Promise<ContinueWorkflowRunResult> => {
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
          await cancelFailedFanInNodeChildren({
            store,
            attemptExecutor: input.attemptExecutor,
            runCoordinationExecutor: input.runCoordinationExecutor,
            workflow: implementation,
            runId: snapshot.run.id,
            node: failedNode,
          })
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

        const workflowCtx = await input.container.createContext(
          implementation.dependencies,
        )
        const outputs = Object.fromEntries(
          snapshot.nodes
            .filter((node) => node.status === 'completed')
            .map((node) => [node.name, node.output]),
        )

        await advanceWorkflowRun({
          store,
          attemptExecutor: input.attemptExecutor,
          runCoordinationExecutor: input.runCoordinationExecutor,
          workflow: implementation,
          workflowCtx: workflowCtx as DependencyContext<any>,
          run: snapshot.run,
          outputs,
          advance: advanceWorkflowRun,
        })
        return { status: 'processed' }
      },
    ).catch((error: unknown) => {
      if (error instanceof StaleRunLeaseError) {
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
): WorkflowStore {
  const fence = async <T>(operation: () => Promise<T>): Promise<T> => {
    const renewedLease = await store.renewRunLease(lease, leaseMs)
    if (!renewedLease) throw new StaleRunLeaseError()
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
    completeRun: (params) => fence(() => store.completeRun(params)),
    failRun: (params) => fence(() => store.failRun(params)),
    requestRunCancellation: (params) =>
      fence(() => store.requestRunCancellation(params)),
    cancelRun: (params) => fence(() => store.cancelRun(params)),
    cancelNode: (params) => fence(() => store.cancelNode(params)),
    cancelNonTerminalRunNodes: (params) =>
      fence(() => store.cancelNonTerminalRunNodes(params)),
    ensureNodeAttempt: (params) => fence(() => store.ensureNodeAttempt(params)),
    ensureChildWorkflowRun: (params) =>
      fence(() => store.ensureChildWorkflowRun(params)),
    ensureChildRun: (params) => fence(() => store.ensureChildRun(params)),
    selectNodeCase: (params) => fence(() => store.selectNodeCase(params)),
    ensureMapItems: (params) => fence(() => store.ensureMapItems(params)),
    completeMapItem: (params) => fence(() => store.completeMapItem(params)),
    failMapItem: (params) => fence(() => store.failMapItem(params)),
    waitNode: (params) => fence(() => store.waitNode(params)),
  }
}

async function runWithRunLeaseRenewal<T>(
  store: WorkflowStore,
  lease: RunLease,
  leaseMs: number,
  handler: () => Promise<T>,
): Promise<T> {
  const intervalMs = Math.max(1, Math.floor(leaseMs / 3))
  const interval = setInterval(() => {
    void store.renewRunLease(lease, leaseMs).catch(() => {})
  }, intervalMs)
  try {
    return await handler()
  } finally {
    clearInterval(interval)
  }
}
