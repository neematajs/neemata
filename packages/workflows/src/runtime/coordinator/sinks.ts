import type { AttemptExecutor, RunCoordinationExecutor } from '../executors.ts'
import type { WorkflowStore } from '../store.ts'
import { wakeParentRun } from '../wake.ts'
import { cancelRunTree } from './cancel.ts'

export async function completeRunAndWakeParent(input: {
  readonly store: WorkflowStore
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly runId: string
  readonly output: unknown
}) {
  const completed = await input.store.completeRun({
    runId: input.runId,
    output: input.output,
  })
  await wakeParentRun({
    store: input.store,
    runCoordinationExecutor: input.runCoordinationExecutor,
    run: completed,
  })
}

export async function failRunAndWakeParent(input: {
  readonly store: WorkflowStore
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly runId: string
  readonly error: unknown
}) {
  const failed = await input.store.failRun({
    runId: input.runId,
    error: input.error,
  })
  await wakeParentRun({
    store: input.store,
    runCoordinationExecutor: input.runCoordinationExecutor,
    run: failed,
  })
}

export async function cancelRunAndWakeParent(input: {
  readonly store: WorkflowStore
  readonly attemptExecutor: AttemptExecutor
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly runId: string
}) {
  const cancelled = await cancelRunTree(input)
  await wakeParentRun({
    store: input.store,
    runCoordinationExecutor: input.runCoordinationExecutor,
    run: cancelled,
  })
}

export async function failNodeAndRun(input: {
  readonly store: WorkflowStore
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly runId: string
  readonly nodeName: string
  readonly error: unknown
}) {
  await input.store.failNode({
    runId: input.runId,
    nodeName: input.nodeName,
    error: input.error,
  })
  await failRunAndWakeParent({
    store: input.store,
    runCoordinationExecutor: input.runCoordinationExecutor,
    runId: input.runId,
    error: input.error,
  })
}

export async function cancelNodeAndRun(input: {
  readonly store: WorkflowStore
  readonly attemptExecutor: AttemptExecutor
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly runId: string
  readonly nodeName: string
}) {
  await input.store.cancelNode({
    runId: input.runId,
    nodeName: input.nodeName,
  })
  await cancelRunAndWakeParent({
    store: input.store,
    attemptExecutor: input.attemptExecutor,
    runCoordinationExecutor: input.runCoordinationExecutor,
    runId: input.runId,
  })
}

export async function failMissingChildRun(input: {
  readonly store: WorkflowStore
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly parentRunId: string
  readonly nodeName: string
  readonly childKind: 'task' | 'workflow'
  readonly childRunId: string
}) {
  const error = new Error(
    `Missing child ${input.childKind} run [${input.childRunId}]`,
  )
  await failNodeAndRun({
    store: input.store,
    runCoordinationExecutor: input.runCoordinationExecutor,
    runId: input.parentRunId,
    nodeName: input.nodeName,
    error,
  })
}
