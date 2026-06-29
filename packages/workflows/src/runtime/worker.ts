import type { Container, DependencyContext } from '@nmtjs/core'

import type {
  ActivityNodeImplementation,
  WorkflowImplementation,
} from '../implement/index.ts'
import type { ClaimedAttempt } from './commands.ts'
import type { AttemptExecutor, RunCoordinationExecutor } from './executors.ts'
import { createWorkflowRuntimeRegistry } from './registry.ts'
import type { WorkflowStore } from './store.ts'

export type RunActivityAttemptInput = {
  readonly store: WorkflowStore
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly attemptExecutor: AttemptExecutor
  readonly workflows: readonly WorkflowImplementation<any, any>[]
  readonly workerId: string
  readonly claimed: ClaimedAttempt
  readonly container: Pick<Container, 'createContext'>
}

export async function runActivityAttempt(
  input: RunActivityAttemptInput,
): Promise<void> {
  const command = input.claimed.command
  if (command.kind !== 'activityAttempt') {
    throw new Error(`Unsupported attempt command kind [${command.kind}]`)
  }

  const registry = createWorkflowRuntimeRegistry({
    workflows: input.workflows as readonly WorkflowImplementation[],
  })
  const workflow = registry.getWorkflow(command.workflowName)
  const node = workflow?.nodes.find(
    (candidate): candidate is ActivityNodeImplementation =>
      candidate.kind === 'activity' && candidate.name === command.nodeName,
  )

  if (!workflow || !node) {
    await input.attemptExecutor.release(input.claimed)
    return
  }

  try {
    const ctx = await input.container.createContext(node.activity.dependencies)
    const output = await node.activity.handler(
      ctx as DependencyContext<any>,
      command.input,
    )
    const attempt = await input.store.completeCurrentAttempt({
      attemptId: command.attemptId,
      leaseToken: command.leaseToken,
      output,
    })

    if (attempt) {
      await input.store.completeNode({
        runId: command.runId,
        nodeName: command.nodeName,
        output,
      })
      await input.runCoordinationExecutor.enqueue({
        kind: 'continueRun',
        runId: command.runId,
        workflowName: command.workflowName,
      })
    }

    await input.attemptExecutor.ack(input.claimed)
  } catch (error) {
    const attempt = await input.store.failCurrentAttempt({
      attemptId: command.attemptId,
      leaseToken: command.leaseToken,
      error,
    })

    if (attempt) {
      await input.store.failNode({
        runId: command.runId,
        nodeName: command.nodeName,
        error,
      })
      await input.runCoordinationExecutor.enqueue({
        kind: 'continueRun',
        runId: command.runId,
        workflowName: command.workflowName,
      })
    }

    await input.attemptExecutor.ack(input.claimed)
  }
}
