import type { RunnableNodeImplementation } from '../../../implement/index.ts'
import type { AdvanceCtx, AdvanceOutcome } from '../context.ts'
import { SELF_CHILD_KEY } from '../../child-key.ts'
import { isTerminalNodeStatus } from '../../status.ts'
import { dispatchChildWorkflow } from '../children.ts'
import {
  encodeWorkflowInput,
  getWorkflowNodeDeclaration,
  hasStoredNodeInput,
  resolveIdempotency,
} from '../codec.ts'
import { runWorkflowUserCallback } from '../context.ts'

export async function dispatchWorkflowNode(
  input: AdvanceCtx & {
    readonly node: RunnableNodeImplementation
  },
): Promise<AdvanceOutcome> {
  const existing = await input.store.createNode({
    runId: input.run.id,
    name: input.node.name,
    kind: 'workflow',
  })
  if (isTerminalNodeStatus(existing.status)) return 'parked'

  await input.store.ensureNodeChildren({
    runId: input.run.id,
    nodeName: input.node.name,
    children: [{ childKey: SELF_CHILD_KEY, kind: 'workflow' }],
  })
  const declaration = getWorkflowNodeDeclaration(
    input.workflow,
    input.node.name,
  )
  return await dispatchChildWorkflow({
    ...input,
    nodeName: input.node.name,
    childKey: SELF_CHILD_KEY,
    workflowName: input.node.target.name,
    cancellation:
      declaration.kind === 'workflow' ? declaration.cancellation : undefined,
    resolveIdempotencyKey: () =>
      resolveIdempotency(
        input.node.idempotency,
        input.outputs,
        input.workflowInput,
      ),
    resolveNodeInput: () => {
      if (hasStoredNodeInput(existing)) return existing.input
      return encodeWorkflowInput(
        input.node.target.input,
        input.node.input
          ? runWorkflowUserCallback(() =>
              input.node.input!(input.outputs, input.workflowInput),
            )
          : input.workflowInput,
        `workflow input [${input.workflow.workflow.name}.${input.node.name}]`,
      )
    },
  })
}
