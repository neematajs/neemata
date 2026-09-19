import { decodeWorkflowUserSchemaValue } from './codec.ts'
import {
  isWorkflowUserCallbackError,
  type AdvanceCtx,
  type AdvanceOutcome,
  unwrapWorkflowUserCallbackError,
} from './context.ts'
import { dispatchActivityNode } from './dispatch/activity.ts'
import { dispatchBranchNode } from './dispatch/branch.ts'
import { dispatchMapTaskNode, dispatchMapWorkflowNode } from './dispatch/map.ts'
import { dispatchParallelNode } from './dispatch/parallel.ts'
import { dispatchTaskNode } from './dispatch/task.ts'
import { dispatchWorkflowNode } from './dispatch/workflow.ts'
import {
  completeRunAndWakeParent,
  failNodeAndRun,
  failRunAndWakeParent,
} from './sinks.ts'

export async function advanceWorkflowRun(
  input: AdvanceCtx,
): Promise<AdvanceOutcome> {
  const nextNode = input.workflow.nodes.find(
    (node) => !Object.hasOwn(input.outputs, node.name),
  )

  if (!nextNode) {
    let output: unknown
    try {
      output = await input.workflow.finish(
        input.workflowCtx,
        input.outputs,
        input.run.input,
      )
      if (input.workflow.workflow.output) {
        output = decodeWorkflowUserSchemaValue(
          input.workflow.workflow.output,
          output,
          `workflow output [${input.workflow.workflow.name}]`,
        )
      }
    } catch (error) {
      await failRunAndWakeParent(input, { runId: input.run.id, error })
      return 'terminal'
    }
    await completeRunAndWakeParent(input, { runId: input.run.id, output })
    return 'terminal'
  }

  try {
    switch (nextNode.kind) {
      case 'task':
        return await dispatchTaskNode({ ...input, node: nextNode })
      case 'workflow':
        return await dispatchWorkflowNode({ ...input, node: nextNode })
      case 'branch':
        return await dispatchBranchNode({ ...input, node: nextNode })
      case 'parallel':
        return await dispatchParallelNode({ ...input, node: nextNode })
      case 'mapTask':
        return await dispatchMapTaskNode({ ...input, node: nextNode })
      case 'mapWorkflow':
        return await dispatchMapWorkflowNode({ ...input, node: nextNode })
      case 'activity':
        return await dispatchActivityNode({ ...input, node: nextNode })
      default:
        nextNode satisfies never
        throw new Error(
          `Unsupported runtime node kind [${String((nextNode as { readonly kind: unknown }).kind)}]`,
        )
    }
  } catch (error) {
    if (!isWorkflowUserCallbackError(error)) throw error
    await failNodeAndRun(input, {
      runId: input.run.id,
      nodeName: nextNode.name,
      error: unwrapWorkflowUserCallbackError(error),
    })
    return 'terminal'
  }
}
