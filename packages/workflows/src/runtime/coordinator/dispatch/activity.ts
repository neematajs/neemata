import type { ActivityNodeImplementation } from '../../../implement/index.ts'
import type { AdvanceCtx } from '../context.ts'
import { isTerminalNodeStatus } from '../../status.ts'
import { dispatchActivityAttempt } from '../attempt.ts'
import {
  decodeWorkflowUserSchemaValue,
  getWorkflowNodeDeclaration,
  hasStoredNodeInput,
  resolveIdempotency,
} from '../codec.ts'
import { runWorkflowUserCallback } from '../context.ts'

export async function dispatchActivityNode(
  input: AdvanceCtx & {
    readonly node: ActivityNodeImplementation
  },
) {
  const existing = await input.store.createNode({
    runId: input.run.id,
    name: input.node.name,
    kind: 'activity',
  })
  if (isTerminalNodeStatus(existing.status)) return
  if (existing.status === 'running' || existing.status === 'waiting') {
    const children = await input.store.loadNodeChildren({
      runId: input.run.id,
      nodeName: input.node.name,
    })
    if (children.attempts.length > 0) return
  }

  const declaration = getWorkflowNodeDeclaration(
    input.workflow,
    input.node.name,
  )
  if (declaration.kind !== 'activity') {
    throw new Error(`Workflow node [${input.node.name}] is not an activity`)
  }
  const nodeInput = hasStoredNodeInput(existing)
    ? existing.input
    : decodeWorkflowUserSchemaValue(
        declaration.input,
        input.node.input
          ? runWorkflowUserCallback(() =>
              input.node.input!(
                input.workflowCtx,
                input.outputs,
                input.run.input,
              ),
            )
          : input.run.input,
        `activity input [${input.workflow.workflow.name}.${input.node.name}]`,
      )

  if (!hasStoredNodeInput(existing)) {
    await input.store.setNodeInput({
      runId: input.run.id,
      nodeName: input.node.name,
      input: nodeInput,
    })
  }

  await dispatchActivityAttempt({
    store: input.store,
    attemptExecutor: input.attemptExecutor,
    runCoordinationExecutor: input.runCoordinationExecutor,
    workflowName: input.workflow.workflow.name,
    activityName: input.node.activity.name,
    runId: input.run.id,
    nodeName: input.node.name,
    prepareAttempt: async () => ({
      attempt: await input.store.createAttempt({
        runId: input.run.id,
        nodeName: input.node.name,
        input: nodeInput,
        idempotencyKey: resolveIdempotency(
          input.node.idempotency,
          input.workflowCtx,
          input.outputs,
          input.run.input,
        ),
      }),
      commandInput: nodeInput,
      created: true,
    }),
  })
}
