import type { RunnableNodeImplementation } from '../../../implement/index.ts'
import type { AdvanceCtx, AdvanceOutcome } from '../context.ts'
import { SELF_CHILD_KEY } from '../../child-key.ts'
import { isTerminalNodeStatus } from '../../status.ts'
import { dispatchChildTaskRun } from '../children.ts'
import {
  encodeWorkflowInput,
  getWorkflowNodeDeclaration,
  hasStoredNodeInput,
  resolveIdempotency,
} from '../codec.ts'
import { runWorkflowUserCallback } from '../context.ts'

export async function dispatchTaskNode(
  input: AdvanceCtx & {
    readonly node: RunnableNodeImplementation
  },
): Promise<AdvanceOutcome> {
  const existing = await input.store.createNode({
    runId: input.run.id,
    name: input.node.name,
    kind: 'task',
  })
  if (isTerminalNodeStatus(existing.status)) return 'parked'
  const declaration = getWorkflowNodeDeclaration(
    input.workflow,
    input.node.name,
  )
  if (declaration.kind !== 'task') {
    throw new Error(`Workflow node [${input.node.name}] is not a task`)
  }

  await input.store.ensureNodeChildren({
    runId: input.run.id,
    nodeName: input.node.name,
    children: [{ childKey: SELF_CHILD_KEY, kind: 'task' }],
  })
  return await dispatchChildTaskRun({
    ...input,
    nodeName: input.node.name,
    childKey: SELF_CHILD_KEY,
    taskName: input.node.target.name,
    timeout: declaration.timeout ?? declaration.task.timeout,
    retry: declaration.retry ?? declaration.task.retry,
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
        `task input [${input.workflow.workflow.name}.${input.node.name}]`,
      )
    },
  })
}
