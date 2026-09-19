import type { Container, DependencyContext } from '@nmtjs/core'

import type { AnyWorkflowImplementation } from '../../implement/index.ts'
import type { ContinueRunCommand } from '../commands.ts'
import type { RuntimeDeps } from '../executors.ts'
import type { RunLease, WorkflowStore } from '../store.ts'
import { DEFAULT_LEASE_MS } from '../executors.ts'
import { createWorkflowRuntimeRegistry } from '../registry.ts'
import { isTerminalRunStatus } from '../status.ts'
import { wakeParentRun } from '../wake.ts'
import { advanceWorkflowRun } from './advance.ts'
import { cancelRunAndWakeParent, failRunAndWakeParent } from './sinks.ts'

class StaleRunLeaseError extends Error {
  constructor() {
    super('Stale workflow run lease')
    this.name = 'StaleRunLeaseError'
  }
}

export type ContinueWorkflowRunInput = RuntimeDeps & {
  readonly container: Pick<Container, 'createContext'>
  readonly workflows: readonly AnyWorkflowImplementation[]
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
  const implementation = registry.getWorkflow(input.command.workflowName)
  if (!implementation) return { status: 'ignored' }

  const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS
  const lease = await input.store.acquireRunLease({
    runId: input.command.runId,
    leaseMs,
  })
  if (!lease) return { status: 'busy' }
  const deps: RuntimeDeps = {
    ...input,
    store: createRunLeaseFencedStore(input.store, lease, leaseMs),
  }

  const intervalMs = Math.max(1, Math.floor(leaseMs / 3))
  // Keeps the lease alive across a long coordination pass; a failed renewal
  // is ignored here because the fenced store rejects the next write anyway.
  const renewal = setInterval(() => {
    void input.store.renewRunLease(lease, leaseMs).catch(() => {})
  }, intervalMs)

  try {
    return await coordinateRun(deps, input, implementation)
  } catch (error) {
    if (error instanceof StaleRunLeaseError) return { status: 'busy' }
    throw error
  } finally {
    clearInterval(renewal)
    await input.store.releaseRunLease(lease)
  }
}

async function coordinateRun(
  deps: RuntimeDeps,
  input: ContinueWorkflowRunInput,
  implementation: AnyWorkflowImplementation,
): Promise<ContinueWorkflowRunResult> {
  const snapshot = await deps.store.loadRunSnapshot(input.command.runId)
  if (!snapshot) return { status: 'ignored' }
  const { run } = snapshot
  if (run.workflowName !== input.command.workflowName) {
    return { status: 'ignored' }
  }
  if (run.status === 'cancelling') {
    await cancelRunAndWakeParent(deps, run.id)
    return { status: 'processed' }
  }
  if (isTerminalRunStatus(run.status)) {
    await wakeParentRun(deps, run)
    return { status: 'processed' }
  }

  const failedNode = snapshot.nodes.find((node) => node.status === 'failed')
  if (failedNode) {
    await failRunAndWakeParent(deps, {
      runId: run.id,
      error:
        failedNode.error ??
        new Error(`Workflow node [${failedNode.name}] failed`),
    })
    return { status: 'processed' }
  }

  if (snapshot.nodes.some((node) => node.status === 'cancelled')) {
    await cancelRunAndWakeParent(deps, run.id)
    return { status: 'processed' }
  }

  const workflowCtx = await input.container.createContext(
    implementation.dependencies,
  )
  const outputs: Record<string, unknown> = {}
  for (const node of snapshot.nodes) {
    if (node.status === 'completed') outputs[node.name] = node.output
  }

  // The run has coordination work from here on; queued/waiting → running
  // before dispatching so status filters see live runs as such.
  await deps.store.markRunRunning({ runId: run.id })

  const outcome = await advanceWorkflowRun({
    ...deps,
    workflow: implementation,
    workflowCtx: workflowCtx as DependencyContext<any>,
    run,
    outputs,
    advance: advanceWorkflowRun,
  })
  if (outcome === 'parked') {
    await deps.store.markRunWaiting({ runId: run.id })
  }
  return { status: 'processed' }
}

/**
 * Writes go through the run lease so a coordinator that lost its lease to a
 * takeover cannot keep mutating the run. Reads and the lease operations
 * themselves stay unfenced: they are either harmless or the fence itself.
 */
const FENCED_METHODS = [
  'createRun',
  'createNode',
  'setNodeInput',
  'createAttempt',
  'completeCurrentAttempt',
  'failCurrentAttempt',
  'completeNode',
  'failNode',
  'markRunRunning',
  'markRunWaiting',
  'completeRun',
  'failRun',
  'requestRunCancellation',
  'cancelRun',
  'cancelNode',
  'cancelNonTerminalRunNodes',
  'ensureNodeChildren',
  'ensureChildRun',
  'ensureChildAttempt',
  'selectNodeCase',
  'completeNodeChild',
  'failNodeChild',
  'waitNode',
] as const satisfies readonly (keyof WorkflowStore)[]

type FencedMethod = (typeof FENCED_METHODS)[number]
type StoreWrite = (params: never) => Promise<unknown>

export function createRunLeaseFencedStore(
  store: WorkflowStore,
  lease: RunLease,
  leaseMs: number,
): WorkflowStore {
  const fenced: WorkflowStore = { ...store }
  // Every fenced method has the same shape, but TypeScript cannot write
  // through a key that is a union of method names without this view.
  const writes = fenced as Record<FencedMethod, StoreWrite>

  for (const name of FENCED_METHODS) {
    const method: StoreWrite = store[name]
    writes[name] = async (params) => {
      const renewed = await store.renewRunLease(lease, leaseMs)
      if (!renewed) throw new StaleRunLeaseError()
      return await method.call(store, params)
    }
  }

  return fenced
}
