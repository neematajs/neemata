import type {
  BranchNodeImplementation,
  WorkflowCaseImplementation,
} from '../../../implement/index.ts'
import type { AnyTaskDefinition } from '../../../types/index.ts'
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
import {
  cancelNodeAndRun,
  completeNodeAndAdvance,
  failNodeAndRun,
} from '../sinks.ts'

export async function dispatchBranchNode(
  input: AdvanceCtx & {
    readonly node: BranchNodeImplementation
  },
): Promise<AdvanceOutcome> {
  const { node } = input
  const runId = input.run.id
  const nodeName = node.name
  const existing = await input.store.createNode({
    runId,
    name: nodeName,
    kind: 'branch',
  })
  if (isTerminalNodeStatus(existing.status)) return 'parked'

  let caseKey = existing.selectedCase
  if (caseKey === undefined) {
    try {
      caseKey = node.select(input.workflowCtx, input.outputs, input.run.input)
    } catch (error) {
      await failNodeAndRun(input, { runId, nodeName, error })
      return 'terminal'
    }

    await input.store.selectNodeCase({ runId, nodeName, caseKey })
  }

  const selected = node.cases[caseKey]
  if (!selected) {
    await failNodeAndRun(input, {
      runId,
      nodeName,
      error: new Error(`Unknown branch case [${nodeName}.${caseKey}]`),
    })
    return 'terminal'
  }
  const declaration = getWorkflowNodeDeclaration(input.workflow, nodeName)
  if (declaration.kind !== 'branch') {
    throw new Error(`Workflow node [${nodeName}] is not a branch`)
  }
  const selectedDeclaration = declaration.cases[caseKey]
  if (!selectedDeclaration) {
    throw new Error(`Missing branch case declaration [${nodeName}.${caseKey}]`)
  }

  const childKey = caseChildKey(caseKey)
  const ensured = await input.store.ensureNodeChildren({
    runId,
    nodeName,
    children: [{ childKey, kind: selected.kind }],
  })
  const child = ensured.children[0]

  if (child.status === 'completed') {
    return await completeNodeAndAdvance(input, nodeName, child.output)
  }
  if (child.status === 'failed') {
    await failNodeAndRun(input, {
      runId,
      nodeName,
      error:
        child.error ?? new Error(`Branch case [${nodeName}.${caseKey}] failed`),
    })
    return 'terminal'
  }
  if (child.status === 'cancelled') {
    await cancelNodeAndRun(input, { runId, nodeName })
    return 'terminal'
  }

  const caseInput = selected.input
  const resolveNodeInput = () => {
    if (hasStoredNodeInput(existing)) return existing.input
    if (!caseInput) return input.run.input

    return runWorkflowUserCallback(() =>
      caseInput(input.workflowCtx, input.outputs, input.run.input),
    )
  }
  const resolveIdempotencyKey = () =>
    resolveIdempotency(
      selected.idempotency,
      input.workflowCtx,
      input.outputs,
      input.run.input,
    )

  if (selected.kind === 'workflow') {
    return await dispatchChildWorkflow({
      ...input,
      nodeName,
      childKey,
      workflowName: selected.target.name,
      inputSchema: selected.target.input,
      inputLabel: `workflow input [${input.workflow.workflow.name}.${nodeName}.${caseKey}]`,
      resolveIdempotencyKey,
      resolveNodeInput,
    })
  }

  if (selected.kind === 'task') {
    if (selectedDeclaration.kind !== 'task') {
      throw new Error(`Branch case [${nodeName}.${caseKey}] is not a task`)
    }
    const target = selected.target as AnyTaskDefinition
    return await dispatchChildTaskRun({
      ...input,
      parentNode: existing,
      nodeName,
      childKey,
      taskName: target.name,
      timeout: selectedDeclaration.timeout ?? target.timeout,
      inputSchema: target.input,
      inputLabel: `task input [${input.workflow.workflow.name}.${nodeName}.${caseKey}]`,
      resolveIdempotencyKey,
      resolveNodeInput,
    })
  }

  if (selected.kind !== 'activity') {
    // Case implementations are user-built, so an unknown kind can still
    // reach this point that the case union has already ruled out.
    const unknown: WorkflowCaseImplementation = selected
    throw new Error(
      `Unsupported branch ${unknown.kind} case [${unknown.name}] in node [${nodeName}]`,
    )
  }

  if (selectedDeclaration.kind !== 'activity') {
    throw new Error(`Branch case [${nodeName}.${caseKey}] is not an activity`)
  }

  // Once the child has an attempt, its input is authoritative — never re-run
  // the user's input callback on re-entry.
  const hasAttempt = child.attemptCount > 0
  let nodeInput: unknown
  let idempotencyKey: readonly unknown[] | undefined
  if (!hasAttempt) {
    const rawInput = caseInput
      ? runWorkflowUserCallback(() =>
          caseInput(input.workflowCtx, input.outputs, input.run.input),
        )
      : input.run.input
    nodeInput = decodeWorkflowUserSchemaValue(
      selectedDeclaration.input,
      rawInput,
      `activity input [${input.workflow.workflow.name}.${nodeName}.${caseKey}]`,
    )
    await input.store.setNodeInput({ runId, nodeName, input: nodeInput })
    idempotencyKey = resolveIdempotency(
      selected.idempotency,
      input.workflowCtx,
      input.outputs,
      input.run.input,
    )
  }

  await dispatchActivityAttempt(input, {
    workflowName: input.workflow.workflow.name,
    activityName: selected.activity.name,
    runId,
    nodeName,
    childKey,
    input: nodeInput,
    idempotencyKey,
  })
  return 'local'
}
