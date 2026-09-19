import type {
  ParallelNodeImplementation,
  WorkflowCaseImplementation,
} from '../../../implement/index.ts'
import type { AnyTaskDefinition, WorkflowNode } from '../../../types/index.ts'
import type { StoredNodeChild, StoredRun } from '../../state.ts'
import type { AdvanceCtx, AdvanceOutcome } from '../context.ts'
import { memberChildKey } from '../../child-key.ts'
import { continueRun } from '../../commands.ts'
import { isTerminalNodeStatus } from '../../status.ts'
import { dispatchTaskRunAttempt, dispatchActivityAttempt } from '../attempt.ts'
import { loadChildRuns, settleChildRun } from '../children.ts'
import {
  decodeWorkflowUserSchemaValue,
  getWorkflowNodeDeclaration,
  resolveIdempotency,
} from '../codec.ts'
import {
  runWorkflowUserCallback,
  isWorkflowUserCallbackError,
  unwrapWorkflowUserCallbackError,
} from '../context.ts'
import {
  cancelNodeAndRun,
  completeNodeAndAdvance,
  failMissingChildRun,
  failNodeAndRun,
} from '../sinks.ts'

type ParallelDeclaration = Extract<WorkflowNode, { readonly kind: 'parallel' }>

type ParallelCtx = AdvanceCtx & {
  readonly node: ParallelNodeImplementation
}

/** What one member contributed to this pass; `terminal` means the run is settled. */
type MemberOutcome =
  | { readonly kind: 'terminal' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'local' }
  | { readonly kind: 'completed'; readonly output: unknown }
  | { readonly kind: 'failed'; readonly error: unknown }

export async function dispatchParallelNode(
  input: ParallelCtx,
): Promise<AdvanceOutcome> {
  const { node } = input
  const runId = input.run.id
  const nodeName = node.name
  const existing = await input.store.createNode({
    runId,
    name: nodeName,
    kind: 'parallel',
  })
  if (isTerminalNodeStatus(existing.status)) return 'parked'

  const declaration = getWorkflowNodeDeclaration(input.workflow, nodeName)
  if (declaration.kind !== 'parallel') {
    throw new Error(`Workflow node [${nodeName}] is not parallel`)
  }
  for (const memberKey of Object.keys(node.cases)) {
    if (!declaration.cases[memberKey]) {
      throw new Error(
        `Missing parallel member declaration [${nodeName}.${memberKey}]`,
      )
    }
  }

  const ensured = await input.store.ensureNodeChildren({
    runId,
    nodeName,
    children: Object.entries(node.cases).map(([memberKey, member]) => ({
      childKey: memberChildKey(memberKey),
      kind: member.kind,
    })),
  })
  const byKey = new Map(
    ensured.children.map((child) => [child.childKey, child]),
  )
  const childRuns = await loadChildRuns(input.store, ensured.children)

  const outputs: Record<string, unknown> = {}
  let hasLocalWork = false
  let failedChildren = 0
  let failure: unknown

  for (const [memberKey, member] of Object.entries(node.cases)) {
    const childKey = memberChildKey(memberKey)
    const child = byKey.get(childKey)
    if (!child) {
      throw new Error(
        `Missing parallel member child [${nodeName}.${memberKey}]`,
      )
    }

    let outcome: MemberOutcome
    try {
      outcome = await dispatchMember(input, {
        declaration,
        memberKey,
        member,
        child,
        childRuns,
      })
    } catch (error) {
      if (!isWorkflowUserCallbackError(error)) throw error
      const cause = unwrapWorkflowUserCallbackError(error)
      await input.store.failNodeChild({
        runId,
        nodeName,
        childKey,
        error: cause,
      })
      outcome = { kind: 'failed', error: cause }
    }

    if (outcome.kind === 'terminal') return 'terminal'
    if (outcome.kind === 'completed') {
      outputs[memberKey] = outcome.output
      continue
    }
    if (outcome.kind === 'failed') {
      failedChildren += 1
      failure ??= outcome.error
      continue
    }
    if (outcome.kind === 'local') hasLocalWork = true
  }

  const expectedCount = Object.keys(node.cases).length
  const completedCount = Object.keys(outputs).length
  if (failedChildren > 0 && completedCount + failedChildren === expectedCount) {
    await failNodeAndRun(input, { runId, nodeName, error: failure })
    return 'terminal'
  }
  if (completedCount === expectedCount) {
    return await completeNodeAndAdvance(input, nodeName, outputs)
  }

  await input.store.waitNode({ runId, nodeName })
  return hasLocalWork ? 'local' : 'parked'
}

async function dispatchMember(
  input: ParallelCtx,
  params: {
    readonly declaration: ParallelDeclaration
    readonly memberKey: string
    readonly member: WorkflowCaseImplementation
    readonly child: StoredNodeChild
    readonly childRuns: ReadonlyMap<string, StoredRun>
  },
): Promise<MemberOutcome> {
  const { declaration, memberKey, member, child } = params
  const runId = input.run.id
  const nodeName = input.node.name
  const { childKey } = child

  if (child.status === 'completed') {
    return { kind: 'completed', output: child.output }
  }
  if (child.status === 'failed') {
    return {
      kind: 'failed',
      error:
        child.error ??
        new Error(`Parallel member [${nodeName}.${memberKey}] failed`),
    }
  }
  if (child.status === 'cancelled') {
    await cancelNodeAndRun(input, { runId, nodeName })
    return { kind: 'terminal' }
  }

  const memberDeclaration = declaration.cases[memberKey]!

  if (member.kind === 'workflow' || member.kind === 'task') {
    const timeout =
      memberDeclaration.kind === 'task' ? memberDeclaration.timeout : undefined
    const target = member.target as AnyTaskDefinition

    if (child.childRunId !== undefined) {
      const childRun = params.childRuns.get(child.childRunId)
      if (!childRun) {
        await failMissingChildRun(input, {
          parentRunId: runId,
          nodeName,
          childKind: member.kind,
          childRunId: child.childRunId,
        })
        return { kind: 'terminal' }
      }

      const settled = await settleChildRun(input, {
        runId,
        nodeName,
        childKey,
        childRun,
        failure: `Parallel child ${member.kind} run [${childRun.id}] ${childRun.status}`,
      })
      if (settled.kind !== 'active') {
        return settled.kind === 'cancelled' ? { kind: 'terminal' } : settled
      }

      if (member.kind === 'workflow') {
        await input.runCoordinationExecutor.enqueue(continueRun(childRun))
      } else {
        await dispatchTaskRunAttempt(input, {
          taskName: target.name,
          taskRunId: childRun.id,
          taskInput: childRun.input ?? input.run.input,
          idempotencyKey: childRun.idempotencyKey,
          timeout: timeout ?? target.timeout,
        })
      }
      return { kind: 'pending' }
    }

    const memberInput = member.input
    const nodeInput = decodeWorkflowUserSchemaValue(
      member.target.input,
      memberInput
        ? runWorkflowUserCallback(() =>
            memberInput(input.workflowCtx, input.outputs, input.run.input),
          )
        : input.run.input,
      `${member.kind} input [${input.workflow.workflow.name}.${nodeName}.${memberKey}]`,
    )
    const idempotencyKey = resolveIdempotency(
      member.idempotency,
      input.workflowCtx,
      input.outputs,
      input.run.input,
    )
    const created = await input.store.ensureChildRun({
      runId,
      nodeName,
      childKey,
      childKind: member.kind,
      childName: member.target.name,
      input: nodeInput,
      rootRunId: input.run.rootRunId,
      idempotencyKey,
    })
    if (member.kind === 'workflow') {
      await input.runCoordinationExecutor.enqueue(continueRun(created.childRun))
    } else {
      await dispatchTaskRunAttempt(input, {
        taskName: target.name,
        taskRunId: created.childRun.id,
        taskInput: nodeInput,
        idempotencyKey,
        timeout: timeout ?? target.timeout,
      })
    }
    return { kind: 'pending' }
  }

  if (member.kind !== 'activity') {
    // Member implementations are user-built, so an unknown kind can still
    // reach this point that the case union has already ruled out.
    const unknown: WorkflowCaseImplementation = member
    throw new Error(
      `Unsupported parallel ${unknown.kind} member [${unknown.name}] in node [${nodeName}]`,
    )
  }
  if (memberDeclaration.kind !== 'activity') {
    throw new Error(
      `Parallel member [${nodeName}.${memberKey}] is not an activity`,
    )
  }

  // Once the member has an attempt, its input is authoritative — never
  // re-run the user's input callback on re-entry.
  const hasAttempt = child.attemptCount > 0
  const memberInput = member.input
  let nodeInput: unknown
  let idempotencyKey: readonly unknown[] | undefined
  if (!hasAttempt) {
    const value = memberInput
      ? runWorkflowUserCallback(() =>
          memberInput(input.workflowCtx, input.outputs, input.run.input),
        )
      : input.run.input
    nodeInput = decodeWorkflowUserSchemaValue(
      memberDeclaration.input,
      value,
      `activity input [${input.workflow.workflow.name}.${nodeName}.${memberKey}]`,
    )
    idempotencyKey = resolveIdempotency(
      member.idempotency,
      input.workflowCtx,
      input.outputs,
      input.run.input,
    )
  }

  await dispatchActivityAttempt(input, {
    workflowName: input.workflow.workflow.name,
    activityName: member.activity.name,
    runId,
    nodeName,
    childKey,
    input: nodeInput,
    idempotencyKey,
  })
  return { kind: 'local' }
}
