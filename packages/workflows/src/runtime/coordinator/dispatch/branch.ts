import type {
  BranchNodeImplementation,
  WorkflowCaseImplementation,
} from '../../../implement/index.ts'
import type {
  AnyTaskDefinition,
  BranchCaseDefinition,
} from '../../../types/index.ts'
import type { NodeChildIdentity } from '../../state.ts'
import type { AdvanceCtx } from '../context.ts'
import { isTerminalNodeStatus } from '../../status.ts'
import { dispatchActivityAttempt } from '../attempt.ts'
import {
  dispatchChildTaskRun,
  dispatchChildWorkflow,
  sameNodeChildIdentity,
} from '../children.ts'
import {
  getWorkflowNodeDeclaration,
  hasStoredNodeInput,
  resolveIdempotency,
  decodeWorkflowUserSchemaValue,
} from '../codec.ts'
import { runWorkflowUserCallback } from '../context.ts'
import { failNodeAndRun } from '../sinks.ts'

export async function dispatchBranchNode(
  input: AdvanceCtx & {
    readonly node: BranchNodeImplementation
  },
) {
  const existing = await input.store.createNode({
    runId: input.run.id,
    name: input.node.name,
    kind: 'branch',
  })
  if (isTerminalNodeStatus(existing.status)) return

  let caseKey = existing.selectedCase
  if (caseKey === undefined) {
    try {
      caseKey = input.node.select(
        input.workflowCtx,
        input.outputs,
        input.run.input,
      )
    } catch (error) {
      await failNodeAndRun({
        store: input.store,
        runCoordinationExecutor: input.runCoordinationExecutor,
        runId: input.run.id,
        nodeName: input.node.name,
        error,
      })
      return
    }

    await input.store.selectNodeCase({
      runId: input.run.id,
      nodeName: input.node.name,
      caseKey,
    })
  }

  const selected = input.node.cases[caseKey]
  if (!selected) {
    const error = new Error(
      `Unknown branch case [${input.node.name}.${caseKey}]`,
    )
    await failNodeAndRun({
      store: input.store,
      runCoordinationExecutor: input.runCoordinationExecutor,
      runId: input.run.id,
      nodeName: input.node.name,
      error,
    })
    return
  }
  const declaration = getWorkflowNodeDeclaration(
    input.workflow,
    input.node.name,
  )
  if (declaration.kind !== 'branch') {
    throw new Error(`Workflow node [${input.node.name}] is not a branch`)
  }
  const selectedDeclaration = declaration.cases[caseKey]
  if (!selectedDeclaration) {
    throw new Error(
      `Missing branch case declaration [${input.node.name}.${caseKey}]`,
    )
  }

  const identity = {
    runId: input.run.id,
    nodeName: input.node.name,
    caseKey,
  } satisfies NodeChildIdentity

  if (selected.kind === 'workflow') {
    await dispatchChildWorkflow({
      ...input,
      nodeName: input.node.name,
      identity,
      workflowName: selected.target.name,
      inputSchema: selected.target.input,
      inputLabel: `workflow input [${input.workflow.workflow.name}.${input.node.name}.${caseKey}]`,
      resolveIdempotencyKey: () =>
        resolveIdempotency(
          selected.idempotency,
          input.workflowCtx,
          input.outputs,
          input.run.input,
        ),
      resolveNodeInput: () =>
        hasStoredNodeInput(existing)
          ? existing.input
          : selected.input
            ? runWorkflowUserCallback(() =>
                selected.input!(
                  input.workflowCtx,
                  input.outputs,
                  input.run.input,
                ),
              )
            : input.run.input,
    })
    return
  }

  if (selected.kind === 'task') {
    if (selectedDeclaration.kind !== 'task') {
      throw new Error(
        `Branch case [${input.node.name}.${caseKey}] is not a task`,
      )
    }
    const taskDeclaration = selectedDeclaration as BranchCaseDefinition<
      'task',
      unknown,
      unknown,
      AnyTaskDefinition
    >
    const taskTarget = selected.target as AnyTaskDefinition
    await dispatchChildTaskRun({
      ...input,
      parentNode: existing,
      nodeName: input.node.name,
      identity,
      taskName: taskTarget.name,
      timeout: taskDeclaration.timeout ?? taskTarget.timeout,
      inputSchema: taskTarget.input,
      inputLabel: `task input [${input.workflow.workflow.name}.${input.node.name}.${caseKey}]`,
      resolveIdempotencyKey: () =>
        resolveIdempotency(
          selected.idempotency,
          input.workflowCtx,
          input.outputs,
          input.run.input,
        ),
      resolveNodeInput: () =>
        hasStoredNodeInput(existing)
          ? existing.input
          : selected.input
            ? runWorkflowUserCallback(() =>
                selected.input!(
                  input.workflowCtx,
                  input.outputs,
                  input.run.input,
                ),
              )
            : input.run.input,
    })
    return
  }

  if (selected.kind !== 'activity') {
    throw unsupportedBranchCase(input.node.name, selected)
  }

  const children = await input.store.loadNodeChildren({
    runId: input.run.id,
    nodeName: input.node.name,
  })
  const existingAttempt = children.attempts.find(
    (attempt) =>
      attempt.identity && sameNodeChildIdentity(attempt.identity, identity),
  )

  if (existingAttempt) {
    await dispatchActivityAttempt({
      store: input.store,
      attemptExecutor: input.attemptExecutor,
      runCoordinationExecutor: input.runCoordinationExecutor,
      workflowName: input.workflow.workflow.name,
      activityName: selected.activity.name,
      runId: input.run.id,
      nodeName: input.node.name,
      prepareAttempt: async () => ({
        attempt: existingAttempt,
        commandInput: existingAttempt.input,
        created: false,
      }),
    })
    return
  }

  if (selectedDeclaration.kind !== 'activity') {
    throw new Error(
      `Branch case [${input.node.name}.${caseKey}] is not an activity`,
    )
  }
  const selectedActivityDeclaration =
    selectedDeclaration as BranchCaseDefinition<'activity'>
  const nodeInput = decodeWorkflowUserSchemaValue(
    selectedActivityDeclaration.input,
    selected.input
      ? runWorkflowUserCallback(() =>
          selected.input!(input.workflowCtx, input.outputs, input.run.input),
        )
      : input.run.input,
    `activity input [${input.workflow.workflow.name}.${input.node.name}.${caseKey}]`,
  )
  const idempotencyKey = resolveIdempotency(
    selected.idempotency,
    input.workflowCtx,
    input.outputs,
    input.run.input,
  )

  await input.store.setNodeInput({
    runId: input.run.id,
    nodeName: input.node.name,
    input: nodeInput,
  })

  await dispatchActivityAttempt({
    store: input.store,
    attemptExecutor: input.attemptExecutor,
    runCoordinationExecutor: input.runCoordinationExecutor,
    workflowName: input.workflow.workflow.name,
    activityName: selected.activity.name,
    runId: input.run.id,
    nodeName: input.node.name,
    prepareAttempt: async () => {
      const result = await input.store.ensureNodeAttempt({
        identity,
        kind: 'activity',
        input: nodeInput,
        idempotencyKey,
      })
      return {
        attempt: result.attempt,
        commandInput: result.created ? nodeInput : result.attempt.input,
        created: result.created,
      }
    },
  })
}

function unsupportedBranchCase(
  nodeName: string,
  selected: WorkflowCaseImplementation,
): Error {
  return new Error(
    `Unsupported branch ${selected.kind} case [${selected.name}] in node [${nodeName}]`,
  )
}
