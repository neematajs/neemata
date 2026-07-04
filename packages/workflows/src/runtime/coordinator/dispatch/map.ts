import type { MapNodeImplementation } from '../../../implement/index.ts'
import type { WorkflowNode } from '../../../types/index.ts'
import type {
  NodeChildIdentity,
  StoredChildLink,
  StoredRun,
} from '../../state.ts'
import type { AdvanceCtx } from '../context.ts'
import { toStoredError } from '../../errors.ts'
import { isTerminalNodeStatus, isTerminalRunStatus } from '../../status.ts'
import { dispatchTaskRunAttempt } from '../attempt.ts'
import { cancelNodeChildRunsAndCommands } from '../cancel.ts'
import { sameNodeChildIdentity } from '../children.ts'
import {
  decodeMapItems,
  decodeWorkflowUserSchemaValue,
  getWorkflowNodeDeclaration,
  mapConcurrencyLimit,
  resolveIdempotency,
} from '../codec.ts'
import { runWorkflowUserCallback } from '../context.ts'
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
    readonly existingLink: StoredChildLink
    readonly childRun: StoredRun
    readonly declaration: Declaration
  }) => Promise<void>
  readonly startChild: (input: {
    readonly identity: NodeChildIdentity
    readonly nodeInput: unknown
    readonly idempotencyKey?: readonly unknown[]
    readonly declaration: Declaration
  }) => Promise<StoredRun>
  readonly failedChildError: (childRun: StoredRun) => unknown
}

export async function dispatchMapTaskNode(input: MapDispatchInput) {
  await dispatchMapRunNode<MapTaskDeclaration>(input, {
    kind: 'mapTask',
    childKind: 'task',
    inputLabel: 'task',
    redispatchActiveChild: async ({ childRun, existingLink, declaration }) => {
      await dispatchTaskRunAttempt({
        store: input.store,
        attemptExecutor: input.attemptExecutor,
        runCoordinationExecutor: input.runCoordinationExecutor,
        taskName: input.node.target.name,
        taskRunId: existingLink.childRunId,
        taskInput: childRun.input ?? input.run.input,
        idempotencyKey: childRun.idempotencyKey,
        timeout: declaration.timeout ?? declaration.task.timeout,
      })
    },
    startChild: async ({
      identity,
      nodeInput,
      idempotencyKey,
      declaration,
    }) => {
      const child = await input.store.ensureChildRun({
        identity,
        childKind: 'task',
        childName: input.node.target.name,
        input: nodeInput,
        parentRunId: input.run.id,
        parentNodeName: input.node.name,
        rootRunId: input.run.rootRunId,
        idempotencyKey,
      })
      await dispatchTaskRunAttempt({
        store: input.store,
        attemptExecutor: input.attemptExecutor,
        runCoordinationExecutor: input.runCoordinationExecutor,
        taskName: input.node.target.name,
        taskRunId: child.childRun.id,
        taskInput: nodeInput,
        idempotencyKey,
        timeout: declaration.timeout ?? declaration.task.timeout,
      })
      return child.childRun
    },
    failedChildError: (childRun) =>
      childRun.error ?? new Error(`Mapped task run [${childRun.id}] failed`),
  })
}

export async function dispatchMapWorkflowNode(input: MapDispatchInput) {
  await dispatchMapRunNode<MapWorkflowDeclaration>(input, {
    kind: 'mapWorkflow',
    childKind: 'workflow',
    inputLabel: 'workflow',
    redispatchActiveChild: async ({ existingLink }) => {
      await input.runCoordinationExecutor.enqueue({
        kind: 'continueRun',
        runId: existingLink.childRunId,
        workflowName: existingLink.workflowName,
      })
    },
    startChild: async ({ identity, nodeInput, idempotencyKey }) => {
      const child = await input.store.ensureChildWorkflowRun({
        identity,
        workflowName: input.node.target.name,
        input: nodeInput,
        parentRunId: input.run.id,
        parentNodeName: input.node.name,
        rootRunId: input.run.rootRunId,
        idempotencyKey,
      })
      await input.runCoordinationExecutor.enqueue({
        kind: 'continueRun',
        runId: child.childRun.id,
        workflowName: input.node.target.name,
      })
      return child.childRun
    },
    failedChildError: (childRun) =>
      childRun.error ??
      new Error(`Mapped child workflow [${childRun.id}] ${childRun.status}`),
  })
}

async function dispatchMapRunNode<Declaration extends MapRunNodeDeclaration>(
  input: MapDispatchInput,
  callbacks: MapRunNodeCallbacks<Declaration>,
) {
  const existing = await input.store.createNode({
    runId: input.run.id,
    name: input.node.name,
    kind: callbacks.kind,
  })
  if (isTerminalNodeStatus(existing.status)) return

  let children = await input.store.loadNodeChildren({
    runId: input.run.id,
    nodeName: input.node.name,
  })
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
  const itemSnapshot =
    children.mapItems.length > 0
      ? children.mapItems
      : (
          await input.store.ensureMapItems({
            runId: input.run.id,
            nodeName: input.node.name,
            items: decodeMapItems(
              typedDeclaration.item,
              runWorkflowUserCallback(() =>
                input.node.items(
                  input.workflowCtx,
                  input.outputs,
                  input.run.input,
                ),
              ),
              `map item [${input.workflow.workflow.name}.${input.node.name}]`,
            ),
          })
        ).items

  if (children.mapItems.length === 0) {
    children = await input.store.loadNodeChildren({
      runId: input.run.id,
      nodeName: input.node.name,
    })
  }

  // Per-item snapshot loads would cost O(items) round-trips on every
  // coordination pass, so load all child run rows in one query instead.
  const childRuns = new Map(
    (
      await input.store.loadRuns(
        children.childLinks.map((link) => link.childRunId),
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
  let activeChildren = 0
  let startedChildren = 0

  for (const item of itemSnapshot) {
    const identity = item.identity
    const existingLink = children.childLinks.find((link) =>
      sameNodeChildIdentity(link.identity, identity),
    )

    if (existingLink) {
      const childRun = childRuns.get(existingLink.childRunId)
      if (!childRun) {
        await failMissingChildRun({
          store: input.store,
          runCoordinationExecutor: input.runCoordinationExecutor,
          parentRunId: input.run.id,
          nodeName: input.node.name,
          childKind: callbacks.childKind,
          childRunId: existingLink.childRunId,
        })
        return
      }

      const childRunIsTerminal = isTerminalRunStatus(childRun.status)
      if (input.node.mode !== 'start-only' && !childRunIsTerminal) {
        activeChildren += 1
      }

      if (input.node.mode === 'start-only') {
        outputItems[item.index] = {
          item: item.item,
          index: item.index,
          runId: existingLink.childRunId,
          status: childRun.status,
        }
        continue
      }

      if (!childRunIsTerminal) {
        await callbacks.redispatchActiveChild({
          existingLink,
          childRun,
          declaration: typedDeclaration,
        })
        continue
      }

      if (childRun.status === 'completed') {
        await input.store.completeMapItem({
          runId: input.run.id,
          nodeName: input.node.name,
          itemIndex: item.index,
          itemKey: item.key,
          output: childRun.output,
        })
        outputItems[item.index] = {
          item: item.item,
          index: item.index,
          runId: existingLink.childRunId,
          ...(input.node.mode === 'wait-settled'
            ? { status: childRun.status }
            : {}),
          output: childRun.output,
        }
        continue
      }

      if (
        childRun.status === 'cancelled' &&
        input.node.mode !== 'wait-settled'
      ) {
        await cancelNodeAndRun({
          store: input.store,
          attemptExecutor: input.attemptExecutor,
          runCoordinationExecutor: input.runCoordinationExecutor,
          runId: input.run.id,
          nodeName: input.node.name,
        })
        return
      }

      const error = callbacks.failedChildError(childRun)
      await input.store.failMapItem({
        runId: input.run.id,
        nodeName: input.node.name,
        itemIndex: item.index,
        itemKey: item.key,
        error,
      })
      if (input.node.mode === 'wait-settled') {
        outputItems[item.index] = {
          item: item.item,
          index: item.index,
          runId: existingLink.childRunId,
          status: childRun.status,
          error: toStoredError(error),
        }
        continue
      }

      await cancelNodeChildRunsAndCommands({
        store: input.store,
        attemptExecutor: input.attemptExecutor,
        runCoordinationExecutor: input.runCoordinationExecutor,
        runId: input.run.id,
        nodeName: input.node.name,
      })
      await failNodeAndRun({
        store: input.store,
        runCoordinationExecutor: input.runCoordinationExecutor,
        runId: input.run.id,
        nodeName: input.node.name,
        error,
      })
      return
    }

    if (input.node.mode === 'start-only') {
      if (startedChildren >= concurrency) continue
    } else if (activeChildren >= concurrency) {
      continue
    }

    const nodeInput = decodeWorkflowUserSchemaValue(
      input.node.target.input,
      runWorkflowUserCallback(() =>
        input.node.input(
          input.workflowCtx,
          input.outputs,
          item.item,
          input.run.input,
          item.index,
        ),
      ),
      `${callbacks.inputLabel} input [${input.workflow.workflow.name}.${input.node.name}.${item.index}]`,
    )
    const idempotencyKey = resolveIdempotency(
      input.node.idempotency,
      input.workflowCtx,
      input.outputs,
      item.item,
      input.run.input,
      item.index,
    )
    const childRun = await callbacks.startChild({
      identity,
      nodeInput,
      idempotencyKey,
      declaration: typedDeclaration,
    })
    if (input.node.mode === 'start-only') {
      startedChildren += 1
      outputItems[item.index] = {
        item: item.item,
        index: item.index,
        runId: childRun.id,
        status: childRun.status,
      }
    } else {
      activeChildren += 1
    }
  }

  const completedItems = outputItems.filter((item) => item !== undefined)
  if (completedItems.length === itemSnapshot.length) {
    const output = { items: completedItems }
    await input.store.completeNode({
      runId: input.run.id,
      nodeName: input.node.name,
      output,
    })
    await input.advance({
      ...input,
      outputs: { ...input.outputs, [input.node.name]: output },
    })
    return
  }

  if (input.node.mode === 'start-only' && startedChildren > 0) {
    await input.runCoordinationExecutor.enqueue({
      kind: 'continueRun',
      runId: input.run.id,
      workflowName: input.workflow.workflow.name,
    })
  }

  await input.store.waitNode({
    runId: input.run.id,
    nodeName: input.node.name,
  })
}
