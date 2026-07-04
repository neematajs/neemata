import type { DurationString, Schema } from '../../types/index.ts'
import type { NodeChildIdentity } from '../state.ts'
import type { AdvanceCtx } from './context.ts'
import { isTerminalRunStatus } from '../status.ts'
import { dispatchTaskRunAttempt } from './attempt.ts'
import { decodeWorkflowUserSchemaValue } from './codec.ts'
import {
  cancelNodeAndRun,
  failMissingChildRun,
  failNodeAndRun,
} from './sinks.ts'

export async function dispatchChildTaskRun(
  input: AdvanceCtx & {
    readonly parentNode: { readonly input?: unknown }
    readonly nodeName: string
    readonly identity: NodeChildIdentity
    readonly taskName: string
    readonly timeout?: DurationString
    readonly inputSchema: Schema
    readonly inputLabel: string
    readonly resolveNodeInput: () => unknown
    readonly resolveIdempotencyKey?: () => readonly unknown[] | undefined
  },
) {
  const children = await input.store.loadNodeChildren({
    runId: input.run.id,
    nodeName: input.nodeName,
  })
  const existingLink = children.childLinks.find((link) =>
    sameNodeChildIdentity(link.identity, input.identity),
  )
  if (existingLink) {
    const snapshot = await input.store.loadRunSnapshot(existingLink.childRunId)
    const childRun = snapshot?.run
    if (!childRun) {
      await failMissingChildRun({
        store: input.store,
        runCoordinationExecutor: input.runCoordinationExecutor,
        parentRunId: input.run.id,
        nodeName: input.nodeName,
        childKind: 'task',
        childRunId: existingLink.childRunId,
      })
      return
    }

    if (!isTerminalRunStatus(childRun.status)) {
      await dispatchTaskRunAttempt({
        store: input.store,
        attemptExecutor: input.attemptExecutor,
        runCoordinationExecutor: input.runCoordinationExecutor,
        taskName: input.taskName,
        taskRunId: existingLink.childRunId,
        taskInput: childRun?.input ?? input.parentNode.input,
        idempotencyKey: childRun.idempotencyKey,
        timeout: input.timeout,
      })
      await input.store.waitNode({
        runId: input.run.id,
        nodeName: input.nodeName,
      })
      return
    }

    if (childRun.status === 'completed') {
      await input.store.completeNode({
        runId: input.run.id,
        nodeName: input.nodeName,
        output: childRun.output,
      })
      await input.advance({
        ...input,
        outputs: { ...input.outputs, [input.nodeName]: childRun.output },
      })
      return
    }

    if (childRun.status === 'cancelled') {
      await cancelNodeAndRun({
        store: input.store,
        attemptExecutor: input.attemptExecutor,
        runCoordinationExecutor: input.runCoordinationExecutor,
        runId: input.run.id,
        nodeName: input.nodeName,
      })
      return
    }

    const error =
      childRun.error ?? new Error(`Child task run [${childRun.id}] failed`)
    await failNodeAndRun({
      store: input.store,
      runCoordinationExecutor: input.runCoordinationExecutor,
      runId: input.run.id,
      nodeName: input.nodeName,
      error,
    })
    return
  }

  const nodeInput = decodeWorkflowUserSchemaValue(
    input.inputSchema,
    input.resolveNodeInput(),
    input.inputLabel,
  )
  const idempotencyKey = input.resolveIdempotencyKey?.()
  await input.store.setNodeInput({
    runId: input.run.id,
    nodeName: input.nodeName,
    input: nodeInput,
  })
  const child = await input.store.ensureChildRun({
    identity: input.identity,
    childKind: 'task',
    childName: input.taskName,
    input: nodeInput,
    parentRunId: input.run.id,
    parentNodeName: input.nodeName,
    rootRunId: input.run.rootRunId,
    idempotencyKey,
  })
  await dispatchTaskRunAttempt({
    store: input.store,
    attemptExecutor: input.attemptExecutor,
    runCoordinationExecutor: input.runCoordinationExecutor,
    taskName: input.taskName,
    taskRunId: child.childRun.id,
    taskInput: nodeInput,
    idempotencyKey,
    timeout: input.timeout,
  })
  await input.store.waitNode({
    runId: input.run.id,
    nodeName: input.nodeName,
  })
}

export async function dispatchChildWorkflow(
  input: AdvanceCtx & {
    readonly nodeName: string
    readonly identity: {
      readonly runId: string
      readonly nodeName: string
      readonly caseKey?: string
    }
    readonly workflowName: string
    readonly inputSchema: Schema
    readonly inputLabel: string
    readonly resolveNodeInput: () => unknown
    readonly resolveIdempotencyKey?: () => readonly unknown[] | undefined
  },
): Promise<void> {
  const children = await input.store.loadNodeChildren({
    runId: input.run.id,
    nodeName: input.nodeName,
  })
  const existingLink = children.childLinks.find((link) =>
    sameNodeChildIdentity(link.identity, input.identity),
  )
  if (existingLink) {
    const snapshot = await input.store.loadRunSnapshot(existingLink.childRunId)
    const childRun = snapshot?.run
    if (!childRun) {
      await failMissingChildRun({
        store: input.store,
        runCoordinationExecutor: input.runCoordinationExecutor,
        parentRunId: input.run.id,
        nodeName: input.nodeName,
        childKind: 'workflow',
        childRunId: existingLink.childRunId,
      })
      return
    }

    if (!isTerminalRunStatus(childRun.status)) {
      await input.runCoordinationExecutor.enqueue({
        kind: 'continueRun',
        runId: existingLink.childRunId,
        workflowName: existingLink.workflowName,
      })
      await input.store.waitNode({
        runId: input.run.id,
        nodeName: input.nodeName,
      })
      return
    }

    if (childRun.status === 'completed') {
      await input.store.completeNode({
        runId: input.run.id,
        nodeName: input.nodeName,
        output: childRun.output,
      })
      const nextOutputs = {
        ...input.outputs,
        [input.nodeName]: childRun.output,
      }
      await input.advance({
        ...input,
        outputs: nextOutputs,
      })
      return
    }

    if (childRun.status === 'cancelled') {
      await cancelNodeAndRun({
        store: input.store,
        attemptExecutor: input.attemptExecutor,
        runCoordinationExecutor: input.runCoordinationExecutor,
        runId: input.run.id,
        nodeName: input.nodeName,
      })
      return
    }

    const error =
      childRun.error ??
      new Error(`Child workflow [${childRun.id}] ${childRun.status}`)
    await failNodeAndRun({
      store: input.store,
      runCoordinationExecutor: input.runCoordinationExecutor,
      runId: input.run.id,
      nodeName: input.nodeName,
      error,
    })
    return
  }

  const nodeInput = decodeWorkflowUserSchemaValue(
    input.inputSchema,
    input.resolveNodeInput(),
    input.inputLabel,
  )
  const idempotencyKey = input.resolveIdempotencyKey?.()
  await input.store.setNodeInput({
    runId: input.run.id,
    nodeName: input.nodeName,
    input: nodeInput,
  })
  const child = await input.store.ensureChildWorkflowRun({
    identity: input.identity,
    workflowName: input.workflowName,
    input: nodeInput,
    parentRunId: input.run.id,
    parentNodeName: input.nodeName,
    rootRunId: input.run.rootRunId,
    idempotencyKey,
  })

  await input.runCoordinationExecutor.enqueue({
    kind: 'continueRun',
    runId: child.childRun.id,
    workflowName: input.workflowName,
  })
  await input.store.waitNode({
    runId: input.run.id,
    nodeName: input.nodeName,
  })
}

export function sameNodeChildIdentity(
  left: NodeChildIdentity,
  right: NodeChildIdentity,
): boolean {
  return (
    left.runId === right.runId &&
    left.nodeName === right.nodeName &&
    left.caseKey === right.caseKey &&
    left.memberKey === right.memberKey &&
    left.itemIndex === right.itemIndex &&
    left.itemKey === right.itemKey
  )
}
