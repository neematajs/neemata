import type { Container, DependencyContext } from '@nmtjs/core'

import type {
  ActivityNodeImplementation,
  BranchNodeImplementation,
  RunnableNodeImplementation,
  WorkflowImplementation,
  WorkflowCaseImplementation,
} from '../implement/index.ts'
import type { ContinueRunCommand } from './commands.ts'
import type { AttemptExecutor, RunCoordinationExecutor } from './executors.ts'
import { createWorkflowRuntimeRegistry } from './registry.ts'
import { isTerminalRunStatus } from './status.ts'
import type { NodeChildIdentity, StoredAttempt, StoredRun } from './state.ts'
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
    if (!snapshot) return
    if (snapshot.run.workflowName !== input.command.workflowName) return
    if (isTerminalRunStatus(snapshot.run.status)) {
      await wakeParentRun({
        store: input.store,
        runCoordinationExecutor: input.runCoordinationExecutor,
        run: snapshot.run,
      })
      return
    }

    const failedNode = snapshot.nodes.find((node) => node.status === 'failed')
    if (failedNode) {
      await failRunAndWakeParent({
        store: input.store,
        runCoordinationExecutor: input.runCoordinationExecutor,
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

    await advanceWorkflowRun({
      store: input.store,
      attemptExecutor: input.attemptExecutor,
      runCoordinationExecutor: input.runCoordinationExecutor,
      workflow: implementation,
      workflowCtx: workflowCtx as DependencyContext<any>,
      run: snapshot.run,
      outputs,
    })
  } finally {
    await input.store.releaseRunLease(lease)
  }
}

async function advanceWorkflowRun(input: {
  readonly store: WorkflowStore
  readonly attemptExecutor: AttemptExecutor
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly workflow: WorkflowImplementation
  readonly workflowCtx: DependencyContext<any>
  readonly run: StoredRun
  readonly outputs: Record<string, unknown>
}) {
  const nextNode = input.workflow.nodes.find(
    (node) => !Object.prototype.hasOwnProperty.call(input.outputs, node.name),
  )

  if (!nextNode) {
    const output = await input.workflow.finish(
      input.workflowCtx,
      input.outputs,
      input.run.input,
    )
    await completeRunAndWakeParent({
      store: input.store,
      runCoordinationExecutor: input.runCoordinationExecutor,
      runId: input.run.id,
      output,
    })
    return
  }

  if (nextNode.kind === 'task') {
    await dispatchTaskNode({
      store: input.store,
      attemptExecutor: input.attemptExecutor,
      runCoordinationExecutor: input.runCoordinationExecutor,
      workflow: input.workflow,
      workflowCtx: input.workflowCtx,
      runId: input.run.id,
      workflowInput: input.run.input,
      outputs: input.outputs,
      node: nextNode,
    })
    return
  }

  if (nextNode.kind === 'workflow') {
    await dispatchWorkflowNode({
      store: input.store,
      attemptExecutor: input.attemptExecutor,
      runCoordinationExecutor: input.runCoordinationExecutor,
      workflow: input.workflow,
      workflowCtx: input.workflowCtx,
      run: input.run,
      outputs: input.outputs,
      node: nextNode,
    })
    return
  }

  if (nextNode.kind === 'branch') {
    await dispatchBranchNode({
      store: input.store,
      attemptExecutor: input.attemptExecutor,
      runCoordinationExecutor: input.runCoordinationExecutor,
      workflow: input.workflow,
      workflowCtx: input.workflowCtx,
      run: input.run,
      outputs: input.outputs,
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
    runCoordinationExecutor: input.runCoordinationExecutor,
    workflow: input.workflow,
    workflowCtx: input.workflowCtx,
    runId: input.run.id,
    workflowInput: input.run.input,
    outputs: input.outputs,
    node: nextNode,
  })
}

async function dispatchTaskNode(input: {
  readonly store: WorkflowStore
  readonly attemptExecutor: AttemptExecutor
  readonly runCoordinationExecutor: RunCoordinationExecutor
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
    await failRunAndWakeParent({
      store: input.store,
      runCoordinationExecutor: input.runCoordinationExecutor,
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
  await wakeParentRun({
    store: input.store,
    runCoordinationExecutor: input.runCoordinationExecutor,
    run: completed,
  })
}

async function failRunAndWakeParent(input: {
  readonly store: WorkflowStore
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly runId: string
  readonly error: unknown
}) {
  const failed = await input.store.failRun({
    runId: input.runId,
    error: input.error,
  })
  await wakeParentRun({
    store: input.store,
    runCoordinationExecutor: input.runCoordinationExecutor,
    run: failed,
  })
}

async function wakeParentRun(input: {
  readonly store: WorkflowStore
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly run: StoredRun | undefined
}) {
  if (!input.run?.parentRunId || !input.run.parentNodeName) return

  const parent = await input.store.loadRunSnapshot(input.run.parentRunId)
  if (!parent) return

  await input.runCoordinationExecutor.enqueue({
    kind: 'continueRun',
    runId: input.run.parentRunId,
    workflowName: parent.run.workflowName,
  })
}

async function dispatchWorkflowNode(input: {
  readonly store: WorkflowStore
  readonly attemptExecutor: AttemptExecutor
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

  await dispatchChildWorkflow({
    store: input.store,
    attemptExecutor: input.attemptExecutor,
    runCoordinationExecutor: input.runCoordinationExecutor,
    workflow: input.workflow,
    workflowCtx: input.workflowCtx,
    run: input.run,
    outputs: input.outputs,
    nodeName: input.node.name,
    identity: {
      runId: input.run.id,
      nodeName: input.node.name,
    },
    workflowName: input.node.target.name,
    resolveNodeInput: () =>
      hasStoredNodeInput(existing)
        ? existing.input
        : input.node.input
          ? input.node.input(input.workflowCtx, input.outputs, input.run.input)
          : input.run.input,
  })
}

async function dispatchChildWorkflow(input: {
  readonly store: WorkflowStore
  readonly attemptExecutor: AttemptExecutor
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly workflow: WorkflowImplementation
  readonly workflowCtx: DependencyContext<any>
  readonly run: StoredRun
  readonly outputs: Record<string, unknown>
  readonly nodeName: string
  readonly identity: {
    readonly runId: string
    readonly nodeName: string
    readonly caseKey?: string
  }
  readonly workflowName: string
  readonly resolveNodeInput: () => unknown
}): Promise<void> {
  const children = await input.store.loadNodeChildren({
    runId: input.run.id,
    nodeName: input.nodeName,
  })
  const existingLink = children.childLinks.find((link) =>
    sameNodeChildIdentity(link.identity, input.identity),
  )
  if (existingLink) {
    const snapshot = await input.store.loadRunSnapshot(existingLink.childRunId)
    const childRun = snapshot?.run
    if (!childRun || !isTerminalRunStatus(childRun.status)) {
      await input.runCoordinationExecutor.enqueue({
        kind: 'continueRun',
        runId: existingLink.childRunId,
        workflowName: existingLink.workflowName,
      })
      await input.store.waitNode({
        runId: input.run.id,
        nodeName: input.nodeName,
      })
      return
    }

    if (childRun.status === 'completed') {
      await input.store.completeNode({
        runId: input.run.id,
        nodeName: input.nodeName,
        output: childRun.output,
      })
      const nextOutputs = { ...input.outputs, [input.nodeName]: childRun.output }
      await advanceWorkflowRun({
        store: input.store,
        attemptExecutor: input.attemptExecutor,
        runCoordinationExecutor: input.runCoordinationExecutor,
        workflow: input.workflow,
        workflowCtx: input.workflowCtx,
        run: input.run,
        outputs: nextOutputs,
      })
      return
    }

    const error =
      childRun.error ??
      new Error(`Child workflow [${childRun.id}] ${childRun.status}`)
    await input.store.failNode({
      runId: input.run.id,
      nodeName: input.nodeName,
      error,
    })
    await failRunAndWakeParent({
      store: input.store,
      runCoordinationExecutor: input.runCoordinationExecutor,
      runId: input.run.id,
      error,
    })
    return
  }

  const nodeInput = input.resolveNodeInput()
  await input.store.setNodeInput({
    runId: input.run.id,
    nodeName: input.nodeName,
    input: nodeInput,
  })
  const child = await input.store.ensureChildWorkflowRun({
    identity: input.identity,
    workflowName: input.workflowName,
    input: nodeInput,
    parentRunId: input.run.id,
    parentNodeName: input.nodeName,
    rootRunId: input.run.rootRunId,
  })

  await input.runCoordinationExecutor.enqueue({
    kind: 'continueRun',
    runId: child.childRun.id,
    workflowName: input.workflowName,
  })
  await input.store.waitNode({
    runId: input.run.id,
    nodeName: input.nodeName,
  })
}

async function dispatchActivityNode(input: {
  readonly store: WorkflowStore
  readonly attemptExecutor: AttemptExecutor
  readonly runCoordinationExecutor: RunCoordinationExecutor
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

  await dispatchActivityAttempt({
    store: input.store,
    attemptExecutor: input.attemptExecutor,
    runCoordinationExecutor: input.runCoordinationExecutor,
    workflowName: input.workflow.workflow.name,
    activityName: input.node.activity.name,
    runId: input.runId,
    nodeName: input.node.name,
    prepareAttempt: async () => ({
      attempt: await input.store.createAttempt({
        runId: input.runId,
        nodeName: input.node.name,
        input: nodeInput,
      }),
      commandInput: nodeInput,
      created: true,
    }),
  })
}

async function dispatchBranchNode(input: {
  readonly store: WorkflowStore
  readonly attemptExecutor: AttemptExecutor
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly workflow: WorkflowImplementation
  readonly workflowCtx: DependencyContext<any>
  readonly run: StoredRun
  readonly outputs: Record<string, unknown>
  readonly node: BranchNodeImplementation
}) {
  const existing = await input.store.createNode({
    runId: input.run.id,
    name: input.node.name,
    kind: 'branch',
  })
  if (existing.status === 'completed' || existing.status === 'failed') return

  let caseKey = existing.selectedCase
  if (caseKey === undefined) {
    try {
      caseKey = input.node.select(input.workflowCtx, input.outputs, input.run.input)
    } catch (error) {
      await input.store.failNode({
        runId: input.run.id,
        nodeName: input.node.name,
        error,
      })
      await failRunAndWakeParent({
        store: input.store,
        runCoordinationExecutor: input.runCoordinationExecutor,
        runId: input.run.id,
        error,
      })
      return
    }

    await input.store.selectNodeCase({
      runId: input.run.id,
      nodeName: input.node.name,
      caseKey,
    })
  }

  const selected = input.node.cases[caseKey]
  if (!selected) {
    const error = new Error(`Unknown branch case [${input.node.name}.${caseKey}]`)
    await input.store.failNode({
      runId: input.run.id,
      nodeName: input.node.name,
      error,
    })
    await failRunAndWakeParent({
      store: input.store,
      runCoordinationExecutor: input.runCoordinationExecutor,
      runId: input.run.id,
      error,
    })
    return
  }

  const identity = {
    runId: input.run.id,
    nodeName: input.node.name,
    caseKey,
  } satisfies NodeChildIdentity

  if (selected.kind === 'workflow') {
    await dispatchChildWorkflow({
      store: input.store,
      attemptExecutor: input.attemptExecutor,
      runCoordinationExecutor: input.runCoordinationExecutor,
      workflow: input.workflow,
      workflowCtx: input.workflowCtx,
      run: input.run,
      outputs: input.outputs,
      nodeName: input.node.name,
      identity,
      workflowName: selected.target.name,
      resolveNodeInput: () =>
        hasStoredNodeInput(existing)
          ? existing.input
          : selected.input
            ? selected.input(input.workflowCtx, input.outputs, input.run.input)
            : input.run.input,
    })
    return
  }

  if (selected.kind === 'task') {
    const children = await input.store.loadNodeChildren({
      runId: input.run.id,
      nodeName: input.node.name,
    })
    const existingAttempt = children.attempts.find(
      (attempt) =>
        attempt.identity && sameNodeChildIdentity(attempt.identity, identity),
    )

    if (existingAttempt) {
      await dispatchTaskAttempt({
        store: input.store,
        attemptExecutor: input.attemptExecutor,
        runCoordinationExecutor: input.runCoordinationExecutor,
        workflowName: input.workflow.workflow.name,
        taskName: selected.target.name,
        runId: input.run.id,
        nodeName: input.node.name,
        prepareAttempt: async () => ({
          attempt: existingAttempt,
          commandInput: existingAttempt.input,
          created: false,
        }),
      })
      return
    }

    const nodeInput = selected.input
      ? selected.input(input.workflowCtx, input.outputs, input.run.input)
      : input.run.input

    await input.store.setNodeInput({
      runId: input.run.id,
      nodeName: input.node.name,
      input: nodeInput,
    })

    await dispatchTaskAttempt({
      store: input.store,
      attemptExecutor: input.attemptExecutor,
      runCoordinationExecutor: input.runCoordinationExecutor,
      workflowName: input.workflow.workflow.name,
      taskName: selected.target.name,
      runId: input.run.id,
      nodeName: input.node.name,
      prepareAttempt: async () => {
        const result = await input.store.ensureNodeAttempt({
          identity,
          kind: 'task',
          input: nodeInput,
        })
        return {
          attempt: result.attempt,
          commandInput: result.created ? nodeInput : result.attempt.input,
          created: result.created,
        }
      },
    })
    return
  }

  if (selected.kind !== 'activity') {
    throw unsupportedBranchCase(input.node.name, selected)
  }

  const children = await input.store.loadNodeChildren({
    runId: input.run.id,
    nodeName: input.node.name,
  })
  const existingAttempt = children.attempts.find(
    (attempt) =>
      attempt.identity && sameNodeChildIdentity(attempt.identity, identity),
  )

  if (existingAttempt) {
    await dispatchActivityAttempt({
      store: input.store,
      attemptExecutor: input.attemptExecutor,
      runCoordinationExecutor: input.runCoordinationExecutor,
      workflowName: input.workflow.workflow.name,
      activityName: selected.activity.name,
      runId: input.run.id,
      nodeName: input.node.name,
      prepareAttempt: async () => ({
        attempt: existingAttempt,
        commandInput: existingAttempt.input,
        created: false,
      }),
    })
    return
  }

  const nodeInput = selected.input
    ? selected.input(input.workflowCtx, input.outputs, input.run.input)
    : input.run.input

  await input.store.setNodeInput({
    runId: input.run.id,
    nodeName: input.node.name,
    input: nodeInput,
  })

  await dispatchActivityAttempt({
    store: input.store,
    attemptExecutor: input.attemptExecutor,
    runCoordinationExecutor: input.runCoordinationExecutor,
    workflowName: input.workflow.workflow.name,
    activityName: selected.activity.name,
    runId: input.run.id,
    nodeName: input.node.name,
    prepareAttempt: async () => {
      const result = await input.store.ensureNodeAttempt({
        identity,
        kind: 'activity',
        input: nodeInput,
      })
      return {
        attempt: result.attempt,
        commandInput: result.created ? nodeInput : result.attempt.input,
        created: result.created,
      }
    },
  })
}

function unsupportedBranchCase(
  nodeName: string,
  selected: WorkflowCaseImplementation,
): Error {
  return new Error(
    `Unsupported branch ${selected.kind} case [${selected.name}] in node [${nodeName}]`,
  )
}

function hasStoredNodeInput(node: { readonly input?: unknown }): boolean {
  return Object.prototype.hasOwnProperty.call(node, 'input')
}

async function dispatchActivityAttempt(input: {
  readonly store: WorkflowStore
  readonly attemptExecutor: AttemptExecutor
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly workflowName: string
  readonly activityName: string
  readonly runId: string
  readonly nodeName: string
  readonly prepareAttempt: () => Promise<{
    readonly attempt: StoredAttempt
    readonly commandInput: unknown
    readonly created: boolean
  }>
}) {
  const { attempt, commandInput, created } = await input.prepareAttempt()

  try {
    await input.attemptExecutor.dispatchActivity({
      kind: 'activityAttempt',
      workflowName: input.workflowName,
      activityName: input.activityName,
      runId: input.runId,
      nodeName: input.nodeName,
      attemptId: attempt.id,
      leaseToken: attempt.leaseToken!,
      input: commandInput,
    })
  } catch (error) {
    if (!created) throw error

    await input.store.failCurrentAttempt({
      attemptId: attempt.id,
      leaseToken: attempt.leaseToken!,
      error,
    })
    await input.store.failNode({
      runId: input.runId,
      nodeName: input.nodeName,
      error,
    })
    await failRunAndWakeParent({
      store: input.store,
      runCoordinationExecutor: input.runCoordinationExecutor,
      runId: input.runId,
      error,
    })
  }
}

async function dispatchTaskAttempt(input: {
  readonly store: WorkflowStore
  readonly attemptExecutor: AttemptExecutor
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly workflowName: string
  readonly taskName: string
  readonly runId: string
  readonly nodeName: string
  readonly prepareAttempt: () => Promise<{
    readonly attempt: StoredAttempt
    readonly commandInput: unknown
    readonly created: boolean
  }>
}) {
  const { attempt, commandInput, created } = await input.prepareAttempt()

  try {
    await input.attemptExecutor.dispatchTask({
      kind: 'taskAttempt',
      workflowName: input.workflowName,
      taskName: input.taskName,
      runId: input.runId,
      nodeName: input.nodeName,
      attemptId: attempt.id,
      leaseToken: attempt.leaseToken!,
      input: commandInput,
    })
  } catch (error) {
    if (!created) throw error

    await input.store.failCurrentAttempt({
      attemptId: attempt.id,
      leaseToken: attempt.leaseToken!,
      error,
    })
    await input.store.failNode({
      runId: input.runId,
      nodeName: input.nodeName,
      error,
    })
    await failRunAndWakeParent({
      store: input.store,
      runCoordinationExecutor: input.runCoordinationExecutor,
      runId: input.runId,
      error,
    })
  }
}

function sameNodeChildIdentity(
  left: NodeChildIdentity,
  right: NodeChildIdentity,
): boolean {
  return (
    left.runId === right.runId &&
    left.nodeName === right.nodeName &&
    left.caseKey === right.caseKey &&
    left.memberKey === right.memberKey &&
    left.itemIndex === right.itemIndex &&
    left.itemKey === right.itemKey
  )
}
