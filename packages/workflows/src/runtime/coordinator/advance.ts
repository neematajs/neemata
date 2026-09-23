import { encodeStoredValue } from '../codec.ts'
import { WorkflowCleanupTimeoutError } from '../handler.ts'
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
      output = await input.handlers.run(
        () =>
          input.workflow.finish(
            input.outputs,
            input.workflowInput,
            { signal: input.signal },
            input.env,
          ),
        input.signal,
      )
      input.signal.throwIfAborted()
      output = encodeStoredValue(
        input.workflow.workflow.output,
        output,
        `workflow output [${input.workflow.workflow.name}]`,
      )
    } catch (error) {
      if (error instanceof WorkflowCleanupTimeoutError) throw error
      // Once aborted, the run is only being released: a finish that rejects
      // in reaction must not surface as a failure of its own.
      if (input.signal.aborted) throw input.signal.reason
      await failRunAndWakeParent({
        store: input.store,
        runCoordinationExecutor: input.runCoordinationExecutor,
        runId: input.run.id,
        error,
      })
      return 'terminal'
    }
    await completeRunAndWakeParent({
      store: input.store,
      runCoordinationExecutor: input.runCoordinationExecutor,
      runId: input.run.id,
      output,
    })
    return 'terminal'
  }

  try {
    if (nextNode.kind === 'task') {
      return await dispatchTaskNode({ ...input, node: nextNode })
    }

    if (nextNode.kind === 'workflow') {
      return await dispatchWorkflowNode({ ...input, node: nextNode })
    }

    if (nextNode.kind === 'branch') {
      return await dispatchBranchNode({ ...input, node: nextNode })
    }

    if (nextNode.kind === 'parallel') {
      return await dispatchParallelNode({ ...input, node: nextNode })
    }

    if (nextNode.kind === 'mapTask') {
      return await dispatchMapTaskNode({ ...input, node: nextNode })
    }

    if (nextNode.kind === 'mapWorkflow') {
      return await dispatchMapWorkflowNode({ ...input, node: nextNode })
    }

    if (nextNode.kind !== 'activity') {
      throw new Error(
        `Unsupported runtime node kind [${String(nextNode.kind)}]`,
      )
    }

    return await dispatchActivityNode({ ...input, node: nextNode })
  } catch (error) {
    if (!isWorkflowUserCallbackError(error)) throw error
    await failNodeAndRun({
      store: input.store,
      runCoordinationExecutor: input.runCoordinationExecutor,
      runId: input.run.id,
      nodeName: nextNode.name,
      error: unwrapWorkflowUserCallbackError(error),
    })
    return 'terminal'
  }
}
