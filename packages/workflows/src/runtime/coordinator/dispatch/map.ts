import type { MapNodeImplementation } from '../../../implement/index.ts'
import type { MapNodeOutput, WorkflowNode } from '../../../types/index.ts'
import type { StoredNodeChild, StoredRun } from '../../state.ts'
import type { AdvanceCtx, AdvanceOutcome } from '../context.ts'
import { itemChildKey } from '../../child-key.ts'
import { continueRun } from '../../commands.ts'
import { isTerminalNodeStatus, isTerminalRunStatus } from '../../status.ts'
import { dispatchTaskRunAttempt } from '../attempt.ts'
import { loadChildRuns, settleChildRun } from '../children.ts'
import {
  decodeMapItems,
  decodeWorkflowUserSchemaValue,
  getWorkflowNodeDeclaration,
  hasStoredNodeInput,
  mapConcurrencyLimit,
  resolveIdempotency,
} from '../codec.ts'
import {
  runWorkflowUserCallback,
  isWorkflowUserCallbackError,
  unwrapWorkflowUserCallbackError,
} from '../context.ts'
import {
  completeNodeAndAdvance,
  failMissingChildRun,
  failNodeAndRun,
} from '../sinks.ts'

type TaskDeclaration = Extract<WorkflowNode, { readonly kind: 'mapTask' }>

type WorkflowDeclaration = Extract<
  WorkflowNode,
  { readonly kind: 'mapWorkflow' }
>

type DispatchInput = AdvanceCtx & {
  readonly node: MapNodeImplementation
}

type MapDeclaration = Extract<
  WorkflowNode,
  { readonly kind: 'mapTask' | 'mapWorkflow' }
>

type MapCallbacks<T extends MapDeclaration> = {
  readonly kind: T['kind']
  readonly childKind: 'task' | 'workflow'
  readonly inputLabel: 'task' | 'workflow'
  readonly redispatchActiveChild: (input: {
    readonly child: StoredNodeChild
    readonly childRun: StoredRun
    readonly declaration: T
  }) => Promise<void>
  readonly startChild: (input: {
    readonly child: StoredNodeChild
    readonly nodeInput: unknown
    readonly idempotencyKey?: readonly unknown[]
    readonly declaration: T
  }) => Promise<void>
  readonly failure: (childRun: StoredRun) => string
}

export async function dispatchMapTaskNode(
  input: DispatchInput,
): Promise<AdvanceOutcome> {
  const target = input.node.target.name
  return await dispatchMap<TaskDeclaration>(input, {
    kind: 'mapTask',
    childKind: 'task',
    inputLabel: 'task',
    redispatchActiveChild: async ({ childRun, declaration }) => {
      await dispatchTaskRunAttempt(input, {
        taskName: target,
        taskRunId: childRun.id,
        taskInput: childRun.input ?? input.run.input,
        idempotencyKey: childRun.idempotencyKey,
        timeout: declaration.timeout ?? declaration.task.timeout,
      })
    },
    startChild: async ({ child, nodeInput, idempotencyKey, declaration }) => {
      const ensured = await input.store.ensureChildRun({
        runId: input.run.id,
        nodeName: input.node.name,
        childKey: child.childKey,
        childKind: 'task',
        childName: target,
        input: nodeInput,
        rootRunId: input.run.rootRunId,
        idempotencyKey,
      })
      await dispatchTaskRunAttempt(input, {
        taskName: target,
        taskRunId: ensured.childRun.id,
        taskInput: nodeInput,
        idempotencyKey,
        timeout: declaration.timeout ?? declaration.task.timeout,
      })
    },
    failure: (childRun) => `Mapped task run [${childRun.id}] failed`,
  })
}

export async function dispatchMapWorkflowNode(
  input: DispatchInput,
): Promise<AdvanceOutcome> {
  const target = input.node.target.name
  return await dispatchMap<WorkflowDeclaration>(input, {
    kind: 'mapWorkflow',
    childKind: 'workflow',
    inputLabel: 'workflow',
    redispatchActiveChild: async ({ childRun }) => {
      await input.runCoordinationExecutor.enqueue(continueRun(childRun))
    },
    startChild: async ({ child, nodeInput, idempotencyKey }) => {
      const ensured = await input.store.ensureChildRun({
        runId: input.run.id,
        nodeName: input.node.name,
        childKey: child.childKey,
        childKind: 'workflow',
        childName: target,
        input: nodeInput,
        rootRunId: input.run.rootRunId,
        idempotencyKey,
      })
      await input.runCoordinationExecutor.enqueue(continueRun(ensured.childRun))
    },
    failure: (childRun) =>
      `Mapped child workflow [${childRun.id}] ${childRun.status}`,
  })
}

async function dispatchMap<T extends MapDeclaration>(
  input: DispatchInput,
  callbacks: MapCallbacks<T>,
): Promise<AdvanceOutcome> {
  const { node } = input
  const runId = input.run.id
  const nodeName = node.name
  const existing = await input.store.createNode({
    runId,
    name: nodeName,
    kind: callbacks.kind,
  })
  if (isTerminalNodeStatus(existing.status)) return 'parked'

  const declaration = getWorkflowNodeDeclaration(input.workflow, nodeName)
  if (declaration.kind !== callbacks.kind) {
    throw new Error(`Workflow node [${nodeName}] is not a ${callbacks.kind}`)
  }
  // The kind check above is the discriminant, but it is written against a
  // generic key that TypeScript cannot relate back to `T`.
  const typedDeclaration = declaration as T

  // The node input records the decoded item list, marking the (possibly
  // empty) item set as ensured so the user's items callback runs only once.
  let children: readonly StoredNodeChild[]
  if (hasStoredNodeInput(existing)) {
    children = (await input.store.loadNodeChildren({ runId, nodeName }))
      .children
  } else {
    const items = decodeMapItems(
      typedDeclaration.item,
      runWorkflowUserCallback(() =>
        node.items(input.workflowCtx, input.outputs, input.run.input),
      ),
      `map item [${input.workflow.workflow.name}.${nodeName}]`,
    )
    children = (
      await input.store.ensureNodeChildren({
        runId,
        nodeName,
        children: items.map((item, index) => ({
          childKey: itemChildKey(index),
          kind: callbacks.childKind,
          ordinal: index,
          item,
        })),
      })
    ).children
    // Commit marker LAST: if we crash before it, re-entry re-derives the
    // items and re-ensures idempotently. Marker-first would let a crash
    // window complete a non-empty map with zero children.
    await input.store.setNodeInput({ runId, nodeName, input: items })
  }

  const childRuns = await loadChildRuns(input.store, children)
  const byOrdinal: Array<
    MapNodeOutput<unknown, unknown>['items'][number] | undefined
  > = []
  const concurrency = mapConcurrencyLimit(node)
  let activeChildren = 0
  for (const { status, childRunId } of children) {
    if (status === 'pending' || childRunId === undefined) continue
    const run = childRuns.get(childRunId)
    if (run && !isTerminalRunStatus(run.status)) activeChildren += 1
  }
  let failedChildren = 0
  let failure: unknown

  for (const child of children) {
    if (child.childRunId !== undefined) {
      const childRun = childRuns.get(child.childRunId)
      if (!childRun) {
        await failMissingChildRun(input, {
          parentRunId: runId,
          nodeName,
          childKind: callbacks.childKind,
          childRunId: child.childRunId,
        })
        return 'terminal'
      }

      const settled = await settleChildRun(input, {
        runId,
        nodeName,
        childKey: child.childKey,
        childRun,
        failure: callbacks.failure(childRun),
      })

      if (settled.kind === 'active') {
        if (child.status === 'pending') {
          if (activeChildren >= concurrency) continue
          await input.store.ensureChildRun({
            runId,
            nodeName,
            childKey: child.childKey,
            childKind: callbacks.childKind,
            childName: childRun.name,
            input: childRun.input,
            rootRunId: input.run.rootRunId,
            idempotencyKey: childRun.idempotencyKey,
          })
          activeChildren += 1
        }
        await callbacks.redispatchActiveChild({
          child,
          childRun,
          declaration: typedDeclaration,
        })
        continue
      }
      if (settled.kind === 'completed') {
        byOrdinal[child.ordinal] = {
          item: child.item,
          index: child.ordinal,
          runId: child.childRunId,
          output: settled.output,
        }
        continue
      }
      if (settled.kind === 'cancelled') return 'terminal'

      failedChildren += 1
      failure ??= settled.error
      continue
    }

    if (child.status === 'failed') {
      failedChildren += 1
      failure ??=
        child.error ?? new Error(`Map item [${child.childKey}] failed`)
      continue
    }
    if (activeChildren >= concurrency) continue

    try {
      const nodeInput = decodeWorkflowUserSchemaValue(
        node.target.input,
        runWorkflowUserCallback(() =>
          node.input(
            input.workflowCtx,
            input.outputs,
            child.item,
            input.run.input,
            child.ordinal,
          ),
        ),
        `${callbacks.inputLabel} input [${input.workflow.workflow.name}.${nodeName}.${child.ordinal}]`,
      )
      const idempotencyKey = resolveIdempotency(
        node.idempotency,
        input.workflowCtx,
        input.outputs,
        child.item,
        input.run.input,
        child.ordinal,
      )
      await callbacks.startChild({
        child,
        nodeInput,
        idempotencyKey,
        declaration: typedDeclaration,
      })
      activeChildren += 1
    } catch (error) {
      if (!isWorkflowUserCallbackError(error)) throw error
      const cause = unwrapWorkflowUserCallbackError(error)
      await input.store.failNodeChild({
        runId,
        nodeName,
        childKey: child.childKey,
        error: cause,
      })
      failedChildren += 1
      failure ??= cause
    }
  }

  const items = byOrdinal.filter((item) => item !== undefined)
  if (failedChildren > 0 && items.length + failedChildren === children.length) {
    await failNodeAndRun(input, { runId, nodeName, error: failure })
    return 'terminal'
  }
  if (items.length === children.length) {
    return await completeNodeAndAdvance(input, nodeName, { items })
  }

  await input.store.waitNode({ runId, nodeName })
  return 'parked'
}
