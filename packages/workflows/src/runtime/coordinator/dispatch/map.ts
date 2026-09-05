import type { MapNodeImplementation } from '../../../implement/index.ts'
import type { WorkflowNode } from '../../../types/index.ts'
import type { StoredNodeChild, StoredRun } from '../../state.ts'
import type { AdvanceCtx, AdvanceOutcome } from '../context.ts'
import { itemChildKey } from '../../child-key.ts'
import { isTerminalNodeStatus, isTerminalRunStatus } from '../../status.ts'
import { dispatchTaskRunAttempt } from '../attempt.ts'
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
  cancelNodeAndRun,
  failMissingChildRun,
  failNodeAndRun,
} from '../sinks.ts'

type MapTaskDeclaration = Extract<WorkflowNode, { readonly kind: 'mapTask' }>

type MapWorkflowDeclaration = Extract<
  WorkflowNode,
  { readonly kind: 'mapWorkflow' }
>

type MapDispatchInput = AdvanceCtx & {
  readonly node: MapNodeImplementation
}

type MapRunNodeDeclaration = Extract<
  WorkflowNode,
  { readonly kind: 'mapTask' | 'mapWorkflow' }
>

type MapRunNodeCallbacks<Declaration extends MapRunNodeDeclaration> = {
  readonly kind: Declaration['kind']
  readonly childKind: 'task' | 'workflow'
  readonly inputLabel: 'task' | 'workflow'
  readonly redispatchActiveChild: (input: {
    readonly child: StoredNodeChild
    readonly childRun: StoredRun
    readonly declaration: Declaration
  }) => Promise<void>
  readonly startChild: (input: {
    readonly child: StoredNodeChild
    readonly nodeInput: unknown
    readonly idempotencyKey?: readonly unknown[]
    readonly declaration: Declaration
  }) => Promise<StoredRun>
  readonly failedChildError: (childRun: StoredRun) => unknown
}

export async function dispatchMapTaskNode(
  input: MapDispatchInput,
): Promise<AdvanceOutcome> {
  return await dispatchMapRunNode<MapTaskDeclaration>(input, {
    kind: 'mapTask',
    childKind: 'task',
    inputLabel: 'task',
    redispatchActiveChild: async ({ childRun, declaration }) => {
      await dispatchTaskRunAttempt({
        store: input.store,
        attemptExecutor: input.attemptExecutor,
        runCoordinationExecutor: input.runCoordinationExecutor,
        taskName: input.node.target.name,
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
        childName: input.node.target.name,
        input: nodeInput,
        rootRunId: input.run.rootRunId,
        idempotencyKey,
      })
      await dispatchTaskRunAttempt({
        store: input.store,
        attemptExecutor: input.attemptExecutor,
        runCoordinationExecutor: input.runCoordinationExecutor,
        taskName: input.node.target.name,
        taskRunId: ensured.childRun.id,
        taskInput: nodeInput,
        idempotencyKey,
        timeout: declaration.timeout ?? declaration.task.timeout,
      })
      return ensured.childRun
    },
    failedChildError: (childRun) =>
      childRun.error ?? new Error(`Mapped task run [${childRun.id}] failed`),
  })
}

export async function dispatchMapWorkflowNode(
  input: MapDispatchInput,
): Promise<AdvanceOutcome> {
  return await dispatchMapRunNode<MapWorkflowDeclaration>(input, {
    kind: 'mapWorkflow',
    childKind: 'workflow',
    inputLabel: 'workflow',
    redispatchActiveChild: async ({ childRun }) => {
      await input.runCoordinationExecutor.enqueue({
        kind: 'continueRun',
        runId: childRun.id,
        workflowName: childRun.workflowName,
      })
    },
    startChild: async ({ child, nodeInput, idempotencyKey }) => {
      const ensured = await input.store.ensureChildRun({
        runId: input.run.id,
        nodeName: input.node.name,
        childKey: child.childKey,
        childKind: 'workflow',
        childName: input.node.target.name,
        input: nodeInput,
        rootRunId: input.run.rootRunId,
        idempotencyKey,
      })
      await input.runCoordinationExecutor.enqueue({
        kind: 'continueRun',
        runId: ensured.childRun.id,
        workflowName: input.node.target.name,
      })
      return ensured.childRun
    },
    failedChildError: (childRun) =>
      childRun.error ??
      new Error(`Mapped child workflow [${childRun.id}] ${childRun.status}`),
  })
}

async function dispatchMapRunNode<Declaration extends MapRunNodeDeclaration>(
  input: MapDispatchInput,
  callbacks: MapRunNodeCallbacks<Declaration>,
): Promise<AdvanceOutcome> {
  const existing = await input.store.createNode({
    runId: input.run.id,
    name: input.node.name,
    kind: callbacks.kind,
  })
  if (isTerminalNodeStatus(existing.status)) return 'parked'

  const declaration = getWorkflowNodeDeclaration(
    input.workflow,
    input.node.name,
  )
  if (declaration.kind !== callbacks.kind) {
    throw new Error(
      `Workflow node [${input.node.name}] is not a ${callbacks.kind}`,
    )
  }
  const typedDeclaration = declaration as Declaration

  // The node input records the decoded item list, marking the (possibly
  // empty) item set as ensured so the user's items callback runs only once.
  let children: readonly StoredNodeChild[]
  if (hasStoredNodeInput(existing)) {
    children = (
      await input.store.loadNodeChildren({
        runId: input.run.id,
        nodeName: input.node.name,
      })
    ).children
  } else {
    const items = decodeMapItems(
      typedDeclaration.item,
      runWorkflowUserCallback(() =>
        input.node.items(input.workflowCtx, input.outputs, input.run.input),
      ),
      `map item [${input.workflow.workflow.name}.${input.node.name}]`,
    )
    children = (
      await input.store.ensureNodeChildren({
        runId: input.run.id,
        nodeName: input.node.name,
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
    await input.store.setNodeInput({
      runId: input.run.id,
      nodeName: input.node.name,
      input: items,
    })
  }

  // Per-item snapshot loads would cost O(items) round-trips on every
  // coordination pass, so load all child run rows in one query instead.
  const childRuns = new Map(
    (
      await input.store.loadRuns(
        children
          .map((child) => child.childRunId)
          .filter((runId): runId is string => runId !== undefined),
      )
    ).map((run) => [run.id, run]),
  )

  const outputItems: Array<{
    item: unknown
    index: number
    runId: string
    status?: string
    output?: unknown
    error?: unknown
  }> = []
  const concurrency = mapConcurrencyLimit(input.node)
  let activeChildren = children.filter(
    (child) =>
      child.status !== 'pending' &&
      child.childRunId !== undefined &&
      childRuns.has(child.childRunId) &&
      !isTerminalRunStatus(childRuns.get(child.childRunId)!.status),
  ).length
  let failedChildren = 0
  let failure: unknown

  for (const child of children) {
    if (child.childRunId !== undefined) {
      const childRun = childRuns.get(child.childRunId)
      if (!childRun) {
        await failMissingChildRun({
          store: input.store,
          runCoordinationExecutor: input.runCoordinationExecutor,
          parentRunId: input.run.id,
          nodeName: input.node.name,
          childKind: callbacks.childKind,
          childRunId: child.childRunId,
        })
        return 'terminal'
      }

      const childRunIsTerminal = isTerminalRunStatus(childRun.status)
      if (!childRunIsTerminal) {
        if (child.status === 'pending') {
          if (activeChildren >= concurrency) continue
          await input.store.ensureChildRun({
            runId: input.run.id,
            nodeName: input.node.name,
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

      if (childRun.status === 'completed') {
        await input.store.completeNodeChild({
          runId: input.run.id,
          nodeName: input.node.name,
          childKey: child.childKey,
          output: childRun.output,
        })
        outputItems[child.ordinal] = {
          item: child.item,
          index: child.ordinal,
          runId: child.childRunId,
          output: childRun.output,
        }
        continue
      }

      if (childRun.status === 'cancelled') {
        await cancelNodeAndRun({
          store: input.store,
          attemptExecutor: input.attemptExecutor,
          runCoordinationExecutor: input.runCoordinationExecutor,
          runId: input.run.id,
          nodeName: input.node.name,
        })
        return 'terminal'
      }

      const error = callbacks.failedChildError(childRun)
      await input.store.failNodeChild({
        runId: input.run.id,
        nodeName: input.node.name,
        childKey: child.childKey,
        error,
      })
      failedChildren += 1
      failure ??= error
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
        input.node.target.input,
        runWorkflowUserCallback(() =>
          input.node.input(
            input.workflowCtx,
            input.outputs,
            child.item,
            input.run.input,
            child.ordinal,
          ),
        ),
        `${callbacks.inputLabel} input [${input.workflow.workflow.name}.${input.node.name}.${child.ordinal}]`,
      )
      const idempotencyKey = resolveIdempotency(
        input.node.idempotency,
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
        runId: input.run.id,
        nodeName: input.node.name,
        childKey: child.childKey,
        error: cause,
      })
      failedChildren += 1
      failure ??= cause
    }
  }

  const completedItems = outputItems.filter((item) => item !== undefined)
  if (
    failedChildren > 0 &&
    completedItems.length + failedChildren === children.length
  ) {
    await failNodeAndRun({
      ...input,
      runId: input.run.id,
      nodeName: input.node.name,
      error: failure,
    })
    return 'terminal'
  }
  if (completedItems.length === children.length) {
    const output = { items: completedItems }
    await input.store.completeNode({
      runId: input.run.id,
      nodeName: input.node.name,
      output,
    })
    return await input.advance({
      ...input,
      outputs: { ...input.outputs, [input.node.name]: output },
    })
  }

  await input.store.waitNode({
    runId: input.run.id,
    nodeName: input.node.name,
  })
  return 'parked'
}
