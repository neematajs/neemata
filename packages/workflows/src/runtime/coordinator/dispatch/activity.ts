import type { ActivityNodeImplementation } from '../../../implement/index.ts'
import type { AdvanceCtx, AdvanceOutcome } from '../context.ts'
import { SELF_CHILD_KEY } from '../../child-key.ts'
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
): Promise<AdvanceOutcome> {
  const existing = await input.store.createNode({
    runId: input.run.id,
    name: input.node.name,
    kind: 'activity',
  })
  if (isTerminalNodeStatus(existing.status)) return 'parked'

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

  const ensured = await input.store.ensureNodeChildren({
    runId: input.run.id,
    nodeName: input.node.name,
    children: [{ childKey: SELF_CHILD_KEY, kind: 'activity' }],
  })
  // Once the child has an attempt, its stored state is authoritative — never
  // re-run the user's idempotency callback on re-entry.
  const hasAttempt = ensured.children[0]!.attemptCount > 0
  await dispatchActivityAttempt({
    store: input.store,
    attemptExecutor: input.attemptExecutor,
    runCoordinationExecutor: input.runCoordinationExecutor,
    workflowName: input.workflow.workflow.name,
    activityName: input.node.activity.name,
    runId: input.run.id,
    nodeName: input.node.name,
    childKey: SELF_CHILD_KEY,
    prepareAttempt: async () => {
      const result = await input.store.ensureChildAttempt({
        runId: input.run.id,
        nodeName: input.node.name,
        childKey: SELF_CHILD_KEY,
        input: nodeInput,
        idempotencyKey: hasAttempt
          ? undefined
          : resolveIdempotency(
              input.node.idempotency,
              input.workflowCtx,
              input.outputs,
              input.run.input,
            ),
      })
      return {
        attempt: result.attempt,
        commandInput: result.created ? nodeInput : result.attempt.input,
        created: result.created,
      }
    },
  })
  return 'local'
}
