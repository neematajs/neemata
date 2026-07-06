import type { DurationString, Schema } from '../../types/index.ts'
import type { AdvanceCtx, AdvanceOutcome } from './context.ts'
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
    readonly childKey: string
    readonly taskName: string
    readonly timeout?: DurationString
    readonly inputSchema: Schema
    readonly inputLabel: string
    readonly resolveNodeInput: () => unknown
    readonly resolveIdempotencyKey?: () => readonly unknown[] | undefined
  },
): Promise<AdvanceOutcome> {
  const children = await input.store.loadNodeChildren({
    runId: input.run.id,
    nodeName: input.nodeName,
  })
  const child = children.children.find(
    (candidate) => candidate.childKey === input.childKey,
  )
  if (child?.childRunId !== undefined) {
    const childRun = (await input.store.loadRuns([child.childRunId]))[0]
    if (!childRun) {
      await failMissingChildRun({
        store: input.store,
        runCoordinationExecutor: input.runCoordinationExecutor,
        parentRunId: input.run.id,
        nodeName: input.nodeName,
        childKind: 'task',
        childRunId: child.childRunId,
      })
      return 'terminal'
    }

    if (!isTerminalRunStatus(childRun.status)) {
      await dispatchTaskRunAttempt({
        store: input.store,
        attemptExecutor: input.attemptExecutor,
        runCoordinationExecutor: input.runCoordinationExecutor,
        taskName: input.taskName,
        taskRunId: child.childRunId,
        taskInput: childRun.input ?? input.parentNode.input,
        idempotencyKey: childRun.idempotencyKey,
        timeout: input.timeout,
      })
      await input.store.waitNode({
        runId: input.run.id,
        nodeName: input.nodeName,
      })
      return 'parked'
    }

    if (childRun.status === 'completed') {
      await input.store.completeNodeChild({
        runId: input.run.id,
        nodeName: input.nodeName,
        childKey: input.childKey,
        output: childRun.output,
      })
      await input.store.completeNode({
        runId: input.run.id,
        nodeName: input.nodeName,
        output: childRun.output,
      })
      return await input.advance({
        ...input,
        outputs: { ...input.outputs, [input.nodeName]: childRun.output },
      })
    }

    if (childRun.status === 'cancelled') {
      await cancelNodeAndRun({
        store: input.store,
        attemptExecutor: input.attemptExecutor,
        runCoordinationExecutor: input.runCoordinationExecutor,
        runId: input.run.id,
        nodeName: input.nodeName,
      })
      return 'terminal'
    }

    const error =
      childRun.error ?? new Error(`Child task run [${childRun.id}] failed`)
    await input.store.failNodeChild({
      runId: input.run.id,
      nodeName: input.nodeName,
      childKey: input.childKey,
      error,
    })
    await failNodeAndRun({
      store: input.store,
      runCoordinationExecutor: input.runCoordinationExecutor,
      runId: input.run.id,
      nodeName: input.nodeName,
      error,
    })
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
    nodeName: input.nodeName,
    input: nodeInput,
  })
  const ensured = await input.store.ensureChildRun({
    runId: input.run.id,
    nodeName: input.nodeName,
    childKey: input.childKey,
    childKind: 'task',
    childName: input.taskName,
    input: nodeInput,
    rootRunId: input.run.rootRunId,
    idempotencyKey,
  })
  await dispatchTaskRunAttempt({
    store: input.store,
    attemptExecutor: input.attemptExecutor,
    runCoordinationExecutor: input.runCoordinationExecutor,
    taskName: input.taskName,
    taskRunId: ensured.childRun.id,
    taskInput: nodeInput,
    idempotencyKey,
    timeout: input.timeout,
  })
  await input.store.waitNode({
    runId: input.run.id,
    nodeName: input.nodeName,
  })
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
  const children = await input.store.loadNodeChildren({
    runId: input.run.id,
    nodeName: input.nodeName,
  })
  const child = children.children.find(
    (candidate) => candidate.childKey === input.childKey,
  )
  if (child?.childRunId !== undefined) {
    const childRun = (await input.store.loadRuns([child.childRunId]))[0]
    if (!childRun) {
      await failMissingChildRun({
        store: input.store,
        runCoordinationExecutor: input.runCoordinationExecutor,
        parentRunId: input.run.id,
        nodeName: input.nodeName,
        childKind: 'workflow',
        childRunId: child.childRunId,
      })
      return 'terminal'
    }

    if (!isTerminalRunStatus(childRun.status)) {
      await input.runCoordinationExecutor.enqueue({
        kind: 'continueRun',
        runId: child.childRunId,
        workflowName: childRun.workflowName,
      })
      await input.store.waitNode({
        runId: input.run.id,
        nodeName: input.nodeName,
      })
      return 'parked'
    }

    if (childRun.status === 'completed') {
      await input.store.completeNodeChild({
        runId: input.run.id,
        nodeName: input.nodeName,
        childKey: input.childKey,
        output: childRun.output,
      })
      await input.store.completeNode({
        runId: input.run.id,
        nodeName: input.nodeName,
        output: childRun.output,
      })
      return await input.advance({
        ...input,
        outputs: { ...input.outputs, [input.nodeName]: childRun.output },
      })
    }

    if (childRun.status === 'cancelled') {
      await cancelNodeAndRun({
        store: input.store,
        attemptExecutor: input.attemptExecutor,
        runCoordinationExecutor: input.runCoordinationExecutor,
        runId: input.run.id,
        nodeName: input.nodeName,
      })
      return 'terminal'
    }

    const error =
      childRun.error ??
      new Error(`Child workflow [${childRun.id}] ${childRun.status}`)
    await input.store.failNodeChild({
      runId: input.run.id,
      nodeName: input.nodeName,
      childKey: input.childKey,
      error,
    })
    await failNodeAndRun({
      store: input.store,
      runCoordinationExecutor: input.runCoordinationExecutor,
      runId: input.run.id,
      nodeName: input.nodeName,
      error,
    })
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
    nodeName: input.nodeName,
    input: nodeInput,
  })
  const ensured = await input.store.ensureChildRun({
    runId: input.run.id,
    nodeName: input.nodeName,
    childKey: input.childKey,
    childKind: 'workflow',
    childName: input.workflowName,
    input: nodeInput,
    rootRunId: input.run.rootRunId,
    idempotencyKey,
  })

  await input.runCoordinationExecutor.enqueue({
    kind: 'continueRun',
    runId: ensured.childRun.id,
    workflowName: input.workflowName,
  })
  await input.store.waitNode({
    runId: input.run.id,
    nodeName: input.nodeName,
  })
  return 'parked'
}
