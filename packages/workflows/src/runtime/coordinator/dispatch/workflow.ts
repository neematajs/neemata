import type { RunnableNodeImplementation } from '../../../implement/index.ts'
import type { AdvanceCtx, AdvanceOutcome } from '../context.ts'
import { SELF_CHILD_KEY } from '../../child-key.ts'
import { isTerminalNodeStatus } from '../../status.ts'
import { dispatchChildWorkflow } from '../children.ts'
import { hasStoredNodeInput, resolveIdempotency } from '../codec.ts'
import { runWorkflowUserCallback } from '../context.ts'

export async function dispatchWorkflowNode(
  input: AdvanceCtx & {
    readonly node: RunnableNodeImplementation
  },
): Promise<AdvanceOutcome> {
  const { node } = input
  const existing = await input.store.createNode({
    runId: input.run.id,
    name: node.name,
    kind: 'workflow',
  })
  if (isTerminalNodeStatus(existing.status)) return 'parked'

  // hoisted for narrowing; invoked with .call so a mapper written as a method
  // still sees its node as `this`
  const nodeInput = node.input
  await input.store.ensureNodeChildren({
    runId: input.run.id,
    nodeName: node.name,
    children: [{ childKey: SELF_CHILD_KEY, kind: 'workflow' }],
  })
  return await dispatchChildWorkflow({
    ...input,
    nodeName: node.name,
    childKey: SELF_CHILD_KEY,
    workflowName: node.target.name,
    inputSchema: node.target.input,
    inputLabel: `workflow input [${input.workflow.workflow.name}.${node.name}]`,
    resolveIdempotencyKey: () =>
      resolveIdempotency(
        node.idempotency,
        input.workflowCtx,
        input.outputs,
        input.run.input,
      ),
    resolveNodeInput: () => {
      if (hasStoredNodeInput(existing)) return existing.input
      if (!nodeInput) return input.run.input

      return runWorkflowUserCallback(() =>
        nodeInput.call(node, input.workflowCtx, input.outputs, input.run.input),
      )
    },
  })
}
