import type { RunnableNodeImplementation } from '../../../implement/index.ts'
import type { AnyTaskDefinition } from '../../../types/index.ts'
import type { AdvanceCtx, AdvanceOutcome } from '../context.ts'
import { SELF_CHILD_KEY } from '../../child-key.ts'
import { isTerminalNodeStatus } from '../../status.ts'
import { dispatchChildTaskRun } from '../children.ts'
import {
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
  const { node } = input
  const existing = await input.store.createNode({
    runId: input.run.id,
    name: node.name,
    kind: 'task',
  })
  if (isTerminalNodeStatus(existing.status)) return 'parked'
  const declaration = getWorkflowNodeDeclaration(input.workflow, node.name)
  if (declaration.kind !== 'task') {
    throw new Error(`Workflow node [${node.name}] is not a task`)
  }

  const target = node.target as AnyTaskDefinition
  const nodeInput = node.input
  await input.store.ensureNodeChildren({
    runId: input.run.id,
    nodeName: node.name,
    children: [{ childKey: SELF_CHILD_KEY, kind: 'task' }],
  })
  return await dispatchChildTaskRun({
    ...input,
    parentNode: existing,
    nodeName: node.name,
    childKey: SELF_CHILD_KEY,
    taskName: target.name,
    timeout: declaration.timeout ?? declaration.task.timeout,
    inputSchema: target.input,
    inputLabel: `task input [${input.workflow.workflow.name}.${node.name}]`,
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
        nodeInput(input.workflowCtx, input.outputs, input.run.input),
      )
    },
  })
}
