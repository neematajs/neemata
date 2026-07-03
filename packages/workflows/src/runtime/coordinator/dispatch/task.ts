import type { RunnableNodeImplementation } from '../../../implement/index.ts'
import type { AnyTaskDefinition } from '../../../types/index.ts'
import type { NodeChildIdentity } from '../../state.ts'
import type { AdvanceCtx } from '../context.ts'
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
) {
  const existing = await input.store.createNode({
    runId: input.run.id,
    name: input.node.name,
    kind: 'task',
  })
  if (isTerminalNodeStatus(existing.status)) return
  const declaration = getWorkflowNodeDeclaration(
    input.workflow,
    input.node.name,
  )
  if (declaration.kind !== 'task') {
    throw new Error(`Workflow node [${input.node.name}] is not a task`)
  }

  await dispatchChildTaskRun({
    ...input,
    parentNode: existing,
    nodeName: input.node.name,
    identity: {
      runId: input.run.id,
      nodeName: input.node.name,
    } satisfies NodeChildIdentity,
    taskName: input.node.target.name,
    timeout: declaration.timeout ?? declaration.task.timeout,
    inputSchema: (input.node.target as AnyTaskDefinition).input,
    inputLabel: `task input [${input.workflow.workflow.name}.${input.node.name}]`,
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
