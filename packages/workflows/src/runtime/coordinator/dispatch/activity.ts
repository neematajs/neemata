import type { ActivityNodeImplementation } from '../../../implement/index.ts'
import type { AdvanceCtx, AdvanceOutcome } from '../context.ts'
import { SELF_CHILD_KEY } from '../../child-key.ts'
import { isTerminalNodeStatus } from '../../status.ts'
import { dispatchActivityAttempt } from '../attempt.ts'
import {
  decodeWorkflowUserSchemaValue,
  getWorkflowNodeDeclaration,
  hasStoredNodeInput,
  resolveIdempotency,
} from '../codec.ts'
import { runWorkflowUserCallback } from '../context.ts'

export async function dispatchActivityNode(
  input: AdvanceCtx & {
    readonly node: ActivityNodeImplementation
  },
): Promise<AdvanceOutcome> {
  const { node } = input
  const existing = await input.store.createNode({
    runId: input.run.id,
    name: node.name,
    kind: 'activity',
  })
  if (isTerminalNodeStatus(existing.status)) return 'parked'

  const declaration = getWorkflowNodeDeclaration(input.workflow, node.name)
  if (declaration.kind !== 'activity') {
    throw new Error(`Workflow node [${node.name}] is not an activity`)
  }
  const inputFn = node.input
  let nodeInput = existing.input
  if (!hasStoredNodeInput(existing)) {
    const rawInput = inputFn
      ? runWorkflowUserCallback(() =>
          inputFn(input.workflowCtx, input.outputs, input.run.input),
        )
      : input.run.input
    nodeInput = decodeWorkflowUserSchemaValue(
      declaration.input,
      rawInput,
      `activity input [${input.workflow.workflow.name}.${node.name}]`,
    )
    await input.store.setNodeInput({
      runId: input.run.id,
      nodeName: node.name,
      input: nodeInput,
    })
  }

  const ensured = await input.store.ensureNodeChildren({
    runId: input.run.id,
    nodeName: node.name,
    children: [{ childKey: SELF_CHILD_KEY, kind: 'activity' }],
  })
  // Once the child has an attempt, its stored state is authoritative — never
  // re-run the user's idempotency callback on re-entry.
  const hasAttempt = ensured.children[0]!.attemptCount > 0
  const idempotencyKey = hasAttempt
    ? undefined
    : resolveIdempotency(
        node.idempotency,
        input.workflowCtx,
        input.outputs,
        input.run.input,
      )

  await dispatchActivityAttempt(input, {
    workflowName: input.workflow.workflow.name,
    activityName: node.activity.name,
    runId: input.run.id,
    nodeName: node.name,
    childKey: SELF_CHILD_KEY,
    input: nodeInput,
    idempotencyKey,
  })
  return 'local'
}
