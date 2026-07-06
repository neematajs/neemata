import type {
  BranchNodeImplementation,
  WorkflowCaseImplementation,
} from '../../../implement/index.ts'
import type {
  AnyTaskDefinition,
  BranchCaseDefinition,
} from '../../../types/index.ts'
import type { AdvanceCtx, AdvanceOutcome } from '../context.ts'
import { caseChildKey } from '../../child-key.ts'
import { isTerminalNodeStatus } from '../../status.ts'
import { dispatchActivityAttempt } from '../attempt.ts'
import { dispatchChildTaskRun, dispatchChildWorkflow } from '../children.ts'
import {
  getWorkflowNodeDeclaration,
  hasStoredNodeInput,
  resolveIdempotency,
  decodeWorkflowUserSchemaValue,
} from '../codec.ts'
import { runWorkflowUserCallback } from '../context.ts'
import { cancelNodeAndRun, failNodeAndRun } from '../sinks.ts'

export async function dispatchBranchNode(
  input: AdvanceCtx & {
    readonly node: BranchNodeImplementation
  },
): Promise<AdvanceOutcome> {
  const existing = await input.store.createNode({
    runId: input.run.id,
    name: input.node.name,
    kind: 'branch',
  })
  if (isTerminalNodeStatus(existing.status)) return 'parked'

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
      return 'terminal'
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
    return 'terminal'
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

  const childKey = caseChildKey(caseKey)
  const ensured = await input.store.ensureNodeChildren({
    runId: input.run.id,
    nodeName: input.node.name,
    children: [{ childKey, kind: selected.kind }],
  })
  const child = ensured.children[0]

  if (child.status === 'completed') {
    await input.store.completeNode({
      runId: input.run.id,
      nodeName: input.node.name,
      output: child.output,
    })
    return await input.advance({
      ...input,
      outputs: { ...input.outputs, [input.node.name]: child.output },
    })
  }
  if (child.status === 'failed') {
    await failNodeAndRun({
      store: input.store,
      runCoordinationExecutor: input.runCoordinationExecutor,
      runId: input.run.id,
      nodeName: input.node.name,
      error:
        child.error ??
        new Error(`Branch case [${input.node.name}.${caseKey}] failed`),
    })
    return 'terminal'
  }
  if (child.status === 'cancelled') {
    await cancelNodeAndRun({
      store: input.store,
      attemptExecutor: input.attemptExecutor,
      runCoordinationExecutor: input.runCoordinationExecutor,
      runId: input.run.id,
      nodeName: input.node.name,
    })
    return 'terminal'
  }

  if (selected.kind === 'workflow') {
    return await dispatchChildWorkflow({
      ...input,
      nodeName: input.node.name,
      childKey,
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
    return await dispatchChildTaskRun({
      ...input,
      parentNode: existing,
      nodeName: input.node.name,
      childKey,
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
  }

  if (selected.kind !== 'activity') {
    throw unsupportedBranchCase(input.node.name, selected)
  }

  if (selectedDeclaration.kind !== 'activity') {
    throw new Error(
      `Branch case [${input.node.name}.${caseKey}] is not an activity`,
    )
  }
  const selectedActivityDeclaration =
    selectedDeclaration as BranchCaseDefinition<'activity'>

  // Once the child has an attempt, its input is authoritative — never re-run
  // the user's input callback on re-entry.
  const hasAttempt = child.attemptCount > 0
  const nodeInput = hasAttempt
    ? undefined
    : decodeWorkflowUserSchemaValue(
        selectedActivityDeclaration.input,
        selected.input
          ? runWorkflowUserCallback(() =>
              selected.input!(
                input.workflowCtx,
                input.outputs,
                input.run.input,
              ),
            )
          : input.run.input,
        `activity input [${input.workflow.workflow.name}.${input.node.name}.${caseKey}]`,
      )

  if (!hasAttempt) {
    await input.store.setNodeInput({
      runId: input.run.id,
      nodeName: input.node.name,
      input: nodeInput,
    })
  }

  await dispatchActivityAttempt({
    store: input.store,
    attemptExecutor: input.attemptExecutor,
    runCoordinationExecutor: input.runCoordinationExecutor,
    workflowName: input.workflow.workflow.name,
    activityName: selected.activity.name,
    runId: input.run.id,
    nodeName: input.node.name,
    childKey,
    prepareAttempt: async () => {
      const result = await input.store.ensureChildAttempt({
        runId: input.run.id,
        nodeName: input.node.name,
        childKey,
        input: nodeInput,
        idempotencyKey: hasAttempt
          ? undefined
          : resolveIdempotency(
              selected.idempotency,
              input.workflowCtx,
              input.outputs,
              input.run.input,
            ),
      })
      return {
        attempt: result.attempt,
        commandInput: result.created ? nodeInput : result.attempt.input,
        created: result.created,
      }
    },
  })
  return 'local'
}

function unsupportedBranchCase(
  nodeName: string,
  selected: WorkflowCaseImplementation,
): Error {
  return new Error(
    `Unsupported branch ${selected.kind} case [${selected.name}] in node [${nodeName}]`,
  )
}
