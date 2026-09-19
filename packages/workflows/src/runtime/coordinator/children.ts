import type { DurationString, Schema } from '../../types/index.ts'
import type { RuntimeDeps } from '../executors.ts'
import type { StoredNodeChild, StoredRun } from '../state.ts'
import type { WorkflowStore } from '../store.ts'
import type { AdvanceCtx, AdvanceOutcome } from './context.ts'
import { continueRun } from '../commands.ts'
import { isTerminalRunStatus } from '../status.ts'
import { dispatchTaskRunAttempt } from './attempt.ts'
import { decodeWorkflowUserSchemaValue } from './codec.ts'
import {
  cancelNodeAndRun,
  completeNodeAndAdvance,
  failMissingChildRun,
  failNodeAndRun,
} from './sinks.ts'

export async function loadChildRuns(
  store: WorkflowStore,
  children: readonly StoredNodeChild[],
) {
  const ids: string[] = []
  for (const { childRunId } of children) {
    if (childRunId !== undefined) ids.push(childRunId)
  }

  // Fan-out coordination needs one snapshot of all child runs per pass.
  const runs = await store.loadRuns(ids)
  return new Map(runs.map((run) => [run.id, run]))
}

export type ChildRunOutcome =
  | { readonly kind: 'active' }
  | { readonly kind: 'completed'; readonly output: unknown }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed'; readonly error: unknown }

/**
 * Records a child run's terminal status on its child row and reports what the
 * node has to aggregate. Cancellation is settled here because it always takes
 * the whole run with it; a failure only marks the child, so fan-in nodes can
 * keep counting their remaining siblings.
 */
export async function settleChildRun(
  deps: RuntimeDeps,
  params: {
    readonly runId: string
    readonly nodeName: string
    readonly childKey: string
    readonly childRun: StoredRun
    /** Used when the child run carries no error of its own. */
    readonly failure: string
  },
): Promise<ChildRunOutcome> {
  const { runId, nodeName, childKey, childRun } = params
  if (!isTerminalRunStatus(childRun.status)) return { kind: 'active' }

  if (childRun.status === 'completed') {
    await deps.store.completeNodeChild({
      runId,
      nodeName,
      childKey,
      output: childRun.output,
    })
    return { kind: 'completed', output: childRun.output }
  }

  if (childRun.status === 'cancelled') {
    await cancelNodeAndRun(deps, { runId, nodeName })
    return { kind: 'cancelled' }
  }

  const error = childRun.error ?? new Error(params.failure)
  await deps.store.failNodeChild({ runId, nodeName, childKey, error })
  return { kind: 'failed', error }
}

export async function dispatchChildTaskRun(
  input: AdvanceCtx & {
    readonly parentNode: { readonly input?: unknown }
    readonly nodeName: string
    readonly childKey: string
    readonly taskName: string
    readonly timeout?: DurationString
    readonly inputSchema: Schema
    readonly inputLabel: string
    readonly resolveNodeInput: () => unknown
    readonly resolveIdempotencyKey?: () => readonly unknown[] | undefined
  },
): Promise<AdvanceOutcome> {
  const { nodeName, childKey, taskName } = input
  const children = await input.store.loadNodeChildren({
    runId: input.run.id,
    nodeName,
  })
  const child = children.children.find(
    (candidate) => candidate.childKey === childKey,
  )
  if (child?.childRunId !== undefined) {
    const childRun = (await input.store.loadRuns([child.childRunId]))[0]
    if (!childRun) {
      await failMissingChildRun(input, {
        parentRunId: input.run.id,
        nodeName,
        childKind: 'task',
        childRunId: child.childRunId,
      })
      return 'terminal'
    }

    const settled = await settleChildRun(input, {
      runId: input.run.id,
      nodeName,
      childKey,
      childRun,
      failure: `Child task run [${childRun.id}] failed`,
    })

    if (settled.kind === 'active') {
      await dispatchTaskRunAttempt(input, {
        taskName,
        taskRunId: child.childRunId,
        taskInput: childRun.input ?? input.parentNode.input,
        idempotencyKey: childRun.idempotencyKey,
        timeout: input.timeout,
      })
      await input.store.waitNode({ runId: input.run.id, nodeName })
      return 'parked'
    }
    if (settled.kind === 'completed') {
      return await completeNodeAndAdvance(input, nodeName, settled.output)
    }
    if (settled.kind === 'failed') {
      await failNodeAndRun(input, {
        runId: input.run.id,
        nodeName,
        error: settled.error,
      })
    }
    return 'terminal'
  }

  const nodeInput = decodeWorkflowUserSchemaValue(
    input.inputSchema,
    input.resolveNodeInput(),
    input.inputLabel,
  )
  const idempotencyKey = input.resolveIdempotencyKey?.()
  await input.store.setNodeInput({
    runId: input.run.id,
    nodeName,
    input: nodeInput,
  })
  const ensured = await input.store.ensureChildRun({
    runId: input.run.id,
    nodeName,
    childKey,
    childKind: 'task',
    childName: taskName,
    input: nodeInput,
    rootRunId: input.run.rootRunId,
    idempotencyKey,
  })
  await dispatchTaskRunAttempt(input, {
    taskName,
    taskRunId: ensured.childRun.id,
    taskInput: nodeInput,
    idempotencyKey,
    timeout: input.timeout,
  })
  await input.store.waitNode({ runId: input.run.id, nodeName })
  return 'parked'
}

export async function dispatchChildWorkflow(
  input: AdvanceCtx & {
    readonly nodeName: string
    readonly childKey: string
    readonly workflowName: string
    readonly inputSchema: Schema
    readonly inputLabel: string
    readonly resolveNodeInput: () => unknown
    readonly resolveIdempotencyKey?: () => readonly unknown[] | undefined
  },
): Promise<AdvanceOutcome> {
  const { nodeName, childKey, workflowName } = input
  const children = await input.store.loadNodeChildren({
    runId: input.run.id,
    nodeName,
  })
  const child = children.children.find(
    (candidate) => candidate.childKey === childKey,
  )
  if (child?.childRunId !== undefined) {
    const childRun = (await input.store.loadRuns([child.childRunId]))[0]
    if (!childRun) {
      await failMissingChildRun(input, {
        parentRunId: input.run.id,
        nodeName,
        childKind: 'workflow',
        childRunId: child.childRunId,
      })
      return 'terminal'
    }

    const settled = await settleChildRun(input, {
      runId: input.run.id,
      nodeName,
      childKey,
      childRun,
      failure: `Child workflow [${childRun.id}] ${childRun.status}`,
    })

    if (settled.kind === 'active') {
      await input.runCoordinationExecutor.enqueue(continueRun(childRun))
      await input.store.waitNode({ runId: input.run.id, nodeName })
      return 'parked'
    }
    if (settled.kind === 'completed') {
      return await completeNodeAndAdvance(input, nodeName, settled.output)
    }
    if (settled.kind === 'failed') {
      await failNodeAndRun(input, {
        runId: input.run.id,
        nodeName,
        error: settled.error,
      })
    }
    return 'terminal'
  }

  const nodeInput = decodeWorkflowUserSchemaValue(
    input.inputSchema,
    input.resolveNodeInput(),
    input.inputLabel,
  )
  const idempotencyKey = input.resolveIdempotencyKey?.()
  await input.store.setNodeInput({
    runId: input.run.id,
    nodeName,
    input: nodeInput,
  })
  const ensured = await input.store.ensureChildRun({
    runId: input.run.id,
    nodeName,
    childKey,
    childKind: 'workflow',
    childName: workflowName,
    input: nodeInput,
    rootRunId: input.run.rootRunId,
    idempotencyKey,
  })

  await input.runCoordinationExecutor.enqueue(continueRun(ensured.childRun))
  await input.store.waitNode({ runId: input.run.id, nodeName })
  return 'parked'
}
