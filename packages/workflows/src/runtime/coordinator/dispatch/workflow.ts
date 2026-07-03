import type { RunnableNodeImplementation } from '../../../implement/index.ts'
import type { AdvanceCtx } from '../context.ts'
import { isTerminalNodeStatus } from '../../status.ts'
import { dispatchChildWorkflow } from '../children.ts'
import { hasStoredNodeInput, resolveIdempotency } from '../codec.ts'
import { runWorkflowUserCallback } from '../context.ts'

export async function dispatchWorkflowNode(
  input: AdvanceCtx & {
    readonly node: RunnableNodeImplementation
  },
) {
  const existing = await input.store.createNode({
    runId: input.run.id,
    name: input.node.name,
    kind: 'workflow',
  })
  if (isTerminalNodeStatus(existing.status)) return

  await dispatchChildWorkflow({
    ...input,
    nodeName: input.node.name,
    identity: {
      runId: input.run.id,
      nodeName: input.node.name,
    },
    workflowName: input.node.target.name,
    inputSchema: input.node.target.input,
    inputLabel: `workflow input [${input.workflow.workflow.name}.${input.node.name}]`,
    resolveIdempotencyKey: () =>
      resolveIdempotency(
        input.node.idempotency,
        input.workflowCtx,
        input.outputs,
        input.run.input,
      ),
    resolveNodeInput: () =>
      hasStoredNodeInput(existing)
        ? existing.input
        : input.node.input
          ? runWorkflowUserCallback(() =>
              input.node.input!(
                input.workflowCtx,
                input.outputs,
                input.run.input,
              ),
            )
          : input.run.input,
  })
}
