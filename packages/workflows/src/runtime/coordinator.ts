import type { Container, DependencyContext } from '@nmtjs/core'

import type {
  ActivityNodeImplementation,
  RunnableNodeImplementation,
  WorkflowImplementation,
} from '../implement/index.ts'
import type { ContinueRunCommand } from './commands.ts'
import type { AttemptExecutor, RunCoordinationExecutor } from './executors.ts'
import { createWorkflowRuntimeRegistry } from './registry.ts'
import { isTerminalRunStatus } from './status.ts'
import type { StoredRun } from './state.ts'
import type { WorkflowStore } from './store.ts'

export type ContinueWorkflowRunInput = {
  readonly store: WorkflowStore
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly attemptExecutor: AttemptExecutor
  readonly container: Pick<Container, 'createContext'>
  readonly workflows: readonly WorkflowImplementation<any, any>[]
  readonly workerId: string
  readonly command: ContinueRunCommand
  readonly leaseMs?: number
}

export async function continueWorkflowRun(
  input: ContinueWorkflowRunInput,
): Promise<void> {
  const registry = createWorkflowRuntimeRegistry({
    workflows: input.workflows as readonly WorkflowImplementation[],
  })
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
    if (snapshot.run.workflowName !== input.command.workflowName) return

    const failedNode = snapshot.nodes.find((node) => node.status === 'failed')
    if (failedNode) {
      await input.store.failRun({
        runId: snapshot.run.id,
        error:
          failedNode.error ??
          new Error(`Workflow node [${failedNode.name}] failed`),
      })
      return
    }

    if (snapshot.nodes.some((node) => node.status === 'cancelled')) return

    const workflowCtx = await input.container.createContext(
      implementation.dependencies,
    )
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
        workflowCtx as DependencyContext<any>,
        outputs,
        snapshot.run.input,
      )
      await completeRunAndWakeParent({
        store: input.store,
        runCoordinationExecutor: input.runCoordinationExecutor,
        runId: snapshot.run.id,
        output,
      })
      return
    }

    if (nextNode.kind === 'task') {
      await dispatchTaskNode({
        store: input.store,
        attemptExecutor: input.attemptExecutor,
        workflow: implementation,
        workflowCtx: workflowCtx as DependencyContext<any>,
        runId: snapshot.run.id,
        workflowInput: snapshot.run.input,
        outputs,
        node: nextNode,
      })
      return
    }

    if (nextNode.kind === 'workflow') {
      await dispatchWorkflowNode({
        store: input.store,
        runCoordinationExecutor: input.runCoordinationExecutor,
        workflow: implementation,
        workflowCtx: workflowCtx as DependencyContext<any>,
        run: snapshot.run,
        outputs,
        node: nextNode,
      })
      return
    }

    if (nextNode.kind !== 'activity') {
      throw new Error(`Unsupported runtime node kind [${nextNode.kind}]`)
    }

    await dispatchActivityNode({
      store: input.store,
      attemptExecutor: input.attemptExecutor,
      workflow: implementation,
      workflowCtx: workflowCtx as DependencyContext<any>,
      runId: snapshot.run.id,
      workflowInput: snapshot.run.input,
      outputs,
      node: nextNode,
    })
  } finally {
    await input.store.releaseRunLease(lease)
  }
}

async function dispatchTaskNode(input: {
  readonly store: WorkflowStore
  readonly attemptExecutor: AttemptExecutor
  readonly workflow: WorkflowImplementation
  readonly workflowCtx: DependencyContext<any>
  readonly runId: string
  readonly workflowInput: unknown
  readonly outputs: Record<string, unknown>
  readonly node: RunnableNodeImplementation
}) {
  const existing = await input.store.createNode({
    runId: input.runId,
    name: input.node.name,
    kind: 'task',
  })
  if (existing.status === 'running' || existing.status === 'waiting') return

  const nodeInput = input.node.input
    ? input.node.input(
        input.workflowCtx,
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

  try {
    await input.attemptExecutor.dispatchTask({
      kind: 'taskAttempt',
      workflowName: input.workflow.workflow.name,
      taskName: input.node.target.name,
      runId: input.runId,
      nodeName: input.node.name,
      attemptId: attempt.id,
      leaseToken: attempt.leaseToken!,
      input: nodeInput,
    })
  } catch (error) {
    await input.store.failCurrentAttempt({
      attemptId: attempt.id,
      leaseToken: attempt.leaseToken!,
      error,
    })
    await input.store.failNode({
      runId: input.runId,
      nodeName: input.node.name,
      error,
    })
    await input.store.failRun({
      runId: input.runId,
      error,
    })
  }
}

async function completeRunAndWakeParent(input: {
  readonly store: WorkflowStore
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly runId: string
  readonly output: unknown
}) {
  const completed = await input.store.completeRun({
    runId: input.runId,
    output: input.output,
  })
  if (!completed?.parentRunId || !completed.parentNodeName) return

  const parent = await input.store.loadRunSnapshot(completed.parentRunId)
  if (!parent) return

  await input.runCoordinationExecutor.enqueue({
    kind: 'continueRun',
    runId: completed.parentRunId,
    workflowName: parent.run.workflowName,
  })
}

async function dispatchWorkflowNode(input: {
  readonly store: WorkflowStore
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly workflow: WorkflowImplementation
  readonly workflowCtx: DependencyContext<any>
  readonly run: StoredRun
  readonly outputs: Record<string, unknown>
  readonly node: RunnableNodeImplementation
}) {
  const existing = await input.store.createNode({
    runId: input.run.id,
    name: input.node.name,
    kind: 'workflow',
  })
  if (existing.status === 'completed' || existing.status === 'failed') return

  const children = await input.store.loadNodeChildren({
    runId: input.run.id,
    nodeName: input.node.name,
  })
  const existingLink = children.childLinks[0]
  if (existingLink) {
    const snapshot = await input.store.loadRunSnapshot(existingLink.childRunId)
    const childRun = snapshot?.run
    if (!childRun || !isTerminalRunStatus(childRun.status)) {
      await input.store.waitNode({
        runId: input.run.id,
        nodeName: input.node.name,
      })
      return
    }

    if (childRun.status === 'completed') {
      await input.store.completeNode({
        runId: input.run.id,
        nodeName: input.node.name,
        output: childRun.output,
      })
      const nodeIndex = input.workflow.nodes.findIndex(
        (node) => node.name === input.node.name,
      )
      if (nodeIndex === input.workflow.nodes.length - 1) {
        const output = await input.workflow.finish(
          input.workflowCtx,
          { ...input.outputs, [input.node.name]: childRun.output },
          input.run.input,
        )
        await completeRunAndWakeParent({
          store: input.store,
          runCoordinationExecutor: input.runCoordinationExecutor,
          runId: input.run.id,
          output,
        })
      }
      return
    }

    await input.store.failNode({
      runId: input.run.id,
      nodeName: input.node.name,
      error:
        childRun.error ??
        new Error(`Child workflow [${childRun.id}] ${childRun.status}`),
    })
    return
  }

  const nodeInput = input.node.input
    ? input.node.input(input.workflowCtx, input.outputs, input.run.input)
    : input.run.input

  await input.store.setNodeInput({
    runId: input.run.id,
    nodeName: input.node.name,
    input: nodeInput,
  })
  const child = await input.store.ensureChildWorkflowRun({
    identity: {
      runId: input.run.id,
      nodeName: input.node.name,
    },
    workflowName: input.node.target.name,
    input: nodeInput,
    parentRunId: input.run.id,
    parentNodeName: input.node.name,
    rootRunId: input.run.rootRunId,
  })

  await input.runCoordinationExecutor.enqueue({
    kind: 'continueRun',
    runId: child.childRun.id,
    workflowName: input.node.target.name,
  })
  await input.store.waitNode({
    runId: input.run.id,
    nodeName: input.node.name,
  })
}

async function dispatchActivityNode(input: {
  readonly store: WorkflowStore
  readonly attemptExecutor: AttemptExecutor
  readonly workflow: WorkflowImplementation
  readonly workflowCtx: DependencyContext<any>
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
        input.workflowCtx,
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

  try {
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
  } catch (error) {
    await input.store.failCurrentAttempt({
      attemptId: attempt.id,
      leaseToken: attempt.leaseToken!,
      error,
    })
    await input.store.failNode({
      runId: input.runId,
      nodeName: input.node.name,
      error,
    })
    await input.store.failRun({
      runId: input.runId,
      error,
    })
  }
}
