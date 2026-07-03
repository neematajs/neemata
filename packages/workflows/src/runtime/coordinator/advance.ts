import { decodeWorkflowUserSchemaValue } from './codec.ts'
import {
  isWorkflowUserCallbackError,
  type AdvanceCtx,
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

export async function advanceWorkflowRun(input: AdvanceCtx) {
  const nextNode = input.workflow.nodes.find(
    (node) => !Object.prototype.hasOwnProperty.call(input.outputs, node.name),
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
      await failRunAndWakeParent({
        store: input.store,
        runCoordinationExecutor: input.runCoordinationExecutor,
        runId: input.run.id,
        error,
      })
      return
    }
    await completeRunAndWakeParent({
      store: input.store,
      runCoordinationExecutor: input.runCoordinationExecutor,
      runId: input.run.id,
      output,
    })
    return
  }

  try {
    if (nextNode.kind === 'task') {
      await dispatchTaskNode({ ...input, node: nextNode })
      return
    }

    if (nextNode.kind === 'workflow') {
      await dispatchWorkflowNode({ ...input, node: nextNode })
      return
    }

    if (nextNode.kind === 'branch') {
      await dispatchBranchNode({ ...input, node: nextNode })
      return
    }

    if (nextNode.kind === 'parallel') {
      await dispatchParallelNode({ ...input, node: nextNode })
      return
    }

    if (nextNode.kind === 'mapTask') {
      await dispatchMapTaskNode({ ...input, node: nextNode })
      return
    }

    if (nextNode.kind === 'mapWorkflow') {
      await dispatchMapWorkflowNode({ ...input, node: nextNode })
      return
    }

    if (nextNode.kind !== 'activity') {
      throw new Error(
        `Unsupported runtime node kind [${String(nextNode.kind)}]`,
      )
    }

    await dispatchActivityNode({ ...input, node: nextNode })
  } catch (error) {
    if (!isWorkflowUserCallbackError(error)) throw error
    await failNodeAndRun({
      store: input.store,
      runCoordinationExecutor: input.runCoordinationExecutor,
      runId: input.run.id,
      nodeName: nextNode.name,
      error: unwrapWorkflowUserCallbackError(error),
    })
  }
}
