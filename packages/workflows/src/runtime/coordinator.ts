import type { DependencyContext } from '@nmtjs/core'

import type {
  ActivityNodeImplementation,
  WorkflowImplementation,
} from '../implement/index.ts'
import type { ContinueRunCommand } from './commands.ts'
import type { AttemptExecutor, RunCoordinationExecutor } from './executors.ts'
import { createWorkflowRuntimeRegistry } from './registry.ts'
import { isTerminalRunStatus } from './status.ts'
import type { WorkflowStore } from './store.ts'

export type ContinueWorkflowRunInput = {
  readonly store: WorkflowStore
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly attemptExecutor: AttemptExecutor
  readonly workflows: readonly WorkflowImplementation[]
  readonly workerId: string
  readonly command: ContinueRunCommand
  readonly leaseMs?: number
}

export async function continueWorkflowRun(
  input: ContinueWorkflowRunInput,
): Promise<void> {
  const registry = createWorkflowRuntimeRegistry({ workflows: input.workflows })
  const implementation = registry.getWorkflow(input.command.workflowName)
  if (!implementation) return

  const lease = await input.store.acquireRunLease({
    runId: input.command.runId,
    workerId: input.workerId,
    leaseMs: input.leaseMs ?? 30_000,
  })
  if (!lease) return

  try {
    const snapshot = await input.store.loadRunSnapshot(input.command.runId)
    if (!snapshot || isTerminalRunStatus(snapshot.run.status)) return

    const outputs = Object.fromEntries(
      snapshot.nodes
        .filter((node) => node.status === 'completed')
        .map((node) => [node.name, node.output]),
    )

    const nextNode = implementation.nodes.find(
      (node) =>
        !snapshot.nodes.some(
          (stored) =>
            stored.name === node.name && stored.status === 'completed',
        ),
    )

    if (!nextNode) {
      const output = await implementation.finish(
        implementation.dependencies as DependencyContext<any>,
        outputs,
        snapshot.run.input,
      )
      await input.store.completeRun({ runId: snapshot.run.id, output })
      return
    }

    if (nextNode.kind !== 'activity') {
      throw new Error(`Unsupported runtime node kind [${nextNode.kind}]`)
    }

    await dispatchActivityNode({
      store: input.store,
      attemptExecutor: input.attemptExecutor,
      workflow: implementation,
      runId: snapshot.run.id,
      workflowInput: snapshot.run.input,
      outputs,
      node: nextNode,
    })
  } finally {
    await input.store.releaseRunLease(lease)
  }
}

async function dispatchActivityNode(input: {
  readonly store: WorkflowStore
  readonly attemptExecutor: AttemptExecutor
  readonly workflow: WorkflowImplementation
  readonly runId: string
  readonly workflowInput: unknown
  readonly outputs: Record<string, unknown>
  readonly node: ActivityNodeImplementation
}) {
  const existing = await input.store.createNode({
    runId: input.runId,
    name: input.node.name,
    kind: 'activity',
  })
  if (existing.status === 'running' || existing.status === 'waiting') return

  const nodeInput = input.node.input
    ? input.node.input(
        input.workflow.dependencies,
        input.outputs,
        input.workflowInput,
      )
    : input.workflowInput

  await input.store.setNodeInput({
    runId: input.runId,
    nodeName: input.node.name,
    input: nodeInput,
  })
  const attempt = await input.store.createAttempt({
    runId: input.runId,
    nodeName: input.node.name,
    input: nodeInput,
  })

  await input.attemptExecutor.dispatchActivity({
    kind: 'activityAttempt',
    workflowName: input.workflow.workflow.name,
    activityName: input.node.activity.name,
    runId: input.runId,
    nodeName: input.node.name,
    attemptId: attempt.id,
    leaseToken: attempt.leaseToken!,
    input: nodeInput,
  })
}
