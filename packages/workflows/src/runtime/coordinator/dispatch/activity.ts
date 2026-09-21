import type { ActivityNodeImplementation } from '../../../implement/index.ts'
import type { AdvanceCtx, AdvanceOutcome } from '../context.ts'
import { SELF_CHILD_KEY } from '../../child-key.ts'
import { isTerminalNodeStatus } from '../../status.ts'
import { dispatchActivityAttempt } from '../attempt.ts'
import {
  decodeWorkflowNodeOutput,
  encodeWorkflowInput,
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
  const existing = await input.store.createNode({
    runId: input.run.id,
    name: input.node.name,
    kind: 'activity',
  })
  if (isTerminalNodeStatus(existing.status)) return 'parked'

  const declaration = getWorkflowNodeDeclaration(
    input.workflow,
    input.node.name,
  )
  if (declaration.kind !== 'activity') {
    throw new Error(`Workflow node [${input.node.name}] is not an activity`)
  }
  let nodeInput = existing.input
  if (!hasStoredNodeInput(existing)) {
    const rawInput = input.node.input
      ? runWorkflowUserCallback(() =>
          input.node.input!(input.outputs, input.workflowInput),
        )
      : input.workflowInput
    nodeInput = encodeWorkflowInput(
      declaration.input,
      rawInput,
      `activity input [${input.workflow.workflow.name}.${input.node.name}]`,
    )
    await input.store.setNodeInput({
      runId: input.run.id,
      nodeName: input.node.name,
      input: nodeInput,
    })
  }

  const ensured = await input.store.ensureNodeChildren({
    runId: input.run.id,
    nodeName: input.node.name,
    children: [{ childKey: SELF_CHILD_KEY, kind: 'activity' }],
  })
  const child = ensured.children[0]!
  // A timeout or cancellation landing between the attempt's settlement and its
  // node completion leaves a completed child under a node that manual retry
  // reopens. Nothing is left to dispatch, so the node settles from the child.
  if (child.status === 'completed') {
    await input.store.completeNode({
      runId: input.run.id,
      nodeName: input.node.name,
      output: child.output,
    })
    return await input.advance({
      ...input,
      outputs: {
        ...input.outputs,
        [input.node.name]: decodeWorkflowNodeOutput(
          input.workflow,
          input.node.name,
          child.output,
        ),
      },
    })
  }
  // Once the child has an attempt, its stored state is authoritative — never
  // re-run the user's idempotency callback on re-entry.
  const hasAttempt = child.attemptCount > 0
  await dispatchActivityAttempt({
    store: input.store,
    attemptExecutor: input.attemptExecutor,
    runCoordinationExecutor: input.runCoordinationExecutor,
    workflowName: input.workflow.workflow.name,
    activityName: input.node.activity.name,
    runId: input.run.id,
    nodeName: input.node.name,
    childKey: SELF_CHILD_KEY,
    retry: input.node.retry,
    prepareAttempt: async () => {
      const result = await input.store.ensureChildAttempt({
        runId: input.run.id,
        nodeName: input.node.name,
        childKey: SELF_CHILD_KEY,
        input: nodeInput,
        idempotencyKey: hasAttempt
          ? undefined
          : resolveIdempotency(
              input.node.idempotency,
              input.outputs,
              input.workflowInput,
            ),
      })
      return {
        attempt: result.attempt,
        commandInput: result.attempt.input,
        created: result.created,
      }
    },
  })
  return 'local'
}
