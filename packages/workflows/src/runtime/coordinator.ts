import type { Container, DependencyContext } from '@nmtjs/core'

import type {
  ActivityNodeImplementation,
  BranchNodeImplementation,
  MapNodeImplementation,
  ParallelNodeImplementation,
  RunnableNodeImplementation,
  WorkflowImplementation,
  WorkflowCaseImplementation,
} from '../implement/index.ts'
import type { AnyTaskDefinition, TaskInput } from '../types/index.ts'
import type { ContinueRunCommand } from './commands.ts'
import type { AttemptExecutor, RunCoordinationExecutor } from './executors.ts'
import { createWorkflowRuntimeRegistry } from './registry.ts'
import { isTerminalRunStatus } from './status.ts'
import type { NodeChildIdentity, StoredAttempt, StoredRun } from './state.ts'
import type { WorkflowStore } from './store.ts'

const TASK_RUN_NODE_NAME = '$task'

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

export type ContinueWorkflowRunResult = {
  readonly status: 'processed' | 'busy' | 'ignored'
}

export type StartTaskRunInput<Task extends AnyTaskDefinition> = {
  readonly store: WorkflowStore
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly attemptExecutor: AttemptExecutor
  readonly task: Task
  readonly input: TaskInput<Task>
  readonly tags?: Readonly<Record<string, string>>
  readonly idempotencyKey?: readonly unknown[]
}

export async function startTaskRun<Task extends AnyTaskDefinition>(
  input: StartTaskRunInput<Task>,
): Promise<StoredRun> {
  const run = await input.store.createRun({
    kind: 'task',
    name: input.task.name,
    workflowName: input.task.name,
    taskName: input.task.name,
    input: input.input,
    tags: input.tags,
    idempotencyKey: input.idempotencyKey,
  })

  await dispatchTaskRunAttempt({
    store: input.store,
    attemptExecutor: input.attemptExecutor,
    runCoordinationExecutor: input.runCoordinationExecutor,
    taskName: input.task.name,
    taskRunId: run.id,
    taskInput: input.input,
  })

  return run
}

export async function continueWorkflowRun(
  input: ContinueWorkflowRunInput,
): Promise<ContinueWorkflowRunResult> {
  const registry = createWorkflowRuntimeRegistry({
    workflows: input.workflows as readonly WorkflowImplementation[],
  })
  const implementation = registry.getWorkflow(input.command.workflowName)
  if (!implementation) return { status: 'ignored' }

  const lease = await input.store.acquireRunLease({
    runId: input.command.runId,
    workerId: input.workerId,
    leaseMs: input.leaseMs ?? 30_000,
  })
  if (!lease) return { status: 'busy' }

  try {
    const snapshot = await input.store.loadRunSnapshot(input.command.runId)
    if (!snapshot) return { status: 'ignored' }
    if (snapshot.run.workflowName !== input.command.workflowName) {
      return { status: 'ignored' }
    }
    if (isTerminalRunStatus(snapshot.run.status)) {
      await wakeParentRun({
        store: input.store,
        runCoordinationExecutor: input.runCoordinationExecutor,
        run: snapshot.run,
      })
      return { status: 'processed' }
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
      return { status: 'processed' }
    }

    if (snapshot.nodes.some((node) => node.status === 'cancelled')) {
      return { status: 'processed' }
    }

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
    return { status: 'processed' }
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
      run: input.run,
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

  if (nextNode.kind === 'parallel') {
    await dispatchParallelNode({
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

  if (nextNode.kind === 'mapTask') {
    await dispatchMapTaskNode({
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

  if (nextNode.kind === 'mapWorkflow') {
    await dispatchMapWorkflowNode({
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
    throw new Error(`Unsupported runtime node kind [${String(nextNode.kind)}]`)
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
  readonly run: StoredRun
  readonly outputs: Record<string, unknown>
  readonly node: RunnableNodeImplementation
}) {
  const existing = await input.store.createNode({
    runId: input.run.id,
    name: input.node.name,
    kind: 'task',
  })
  if (existing.status === 'completed' || existing.status === 'failed') return

  await dispatchChildTaskRun({
    store: input.store,
    attemptExecutor: input.attemptExecutor,
    runCoordinationExecutor: input.runCoordinationExecutor,
    workflow: input.workflow,
    workflowCtx: input.workflowCtx,
    run: input.run,
    outputs: input.outputs,
    parentNode: existing,
    nodeName: input.node.name,
    identity: {
      runId: input.run.id,
      nodeName: input.node.name,
    },
    taskName: input.node.target.name,
    resolveNodeInput: () =>
      hasStoredNodeInput(existing)
        ? existing.input
        : input.node.input
          ? input.node.input(
              input.workflowCtx,
              input.outputs,
              input.run.input,
            )
          : input.run.input,
  })
}

async function dispatchChildTaskRun(input: {
  readonly store: WorkflowStore
  readonly attemptExecutor: AttemptExecutor
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly workflow: WorkflowImplementation
  readonly workflowCtx: DependencyContext<any>
  readonly run: StoredRun
  readonly outputs: Record<string, unknown>
  readonly parentNode: { readonly input?: unknown }
  readonly nodeName: string
  readonly identity: NodeChildIdentity
  readonly taskName: string
  readonly resolveNodeInput: () => unknown
}) {
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
    if (!childRun) {
      await failMissingChildRun({
        store: input.store,
        runCoordinationExecutor: input.runCoordinationExecutor,
        parentRunId: input.run.id,
        nodeName: input.nodeName,
        childKind: 'task',
        childRunId: existingLink.childRunId,
      })
      return
    }

    if (!isTerminalRunStatus(childRun.status)) {
      await dispatchTaskRunAttempt({
        store: input.store,
        attemptExecutor: input.attemptExecutor,
        runCoordinationExecutor: input.runCoordinationExecutor,
        taskName: input.taskName,
        taskRunId: existingLink.childRunId,
        taskInput: childRun?.input ?? input.parentNode.input,
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
      await advanceWorkflowRun({
        store: input.store,
        attemptExecutor: input.attemptExecutor,
        runCoordinationExecutor: input.runCoordinationExecutor,
        workflow: input.workflow,
        workflowCtx: input.workflowCtx,
        run: input.run,
        outputs: { ...input.outputs, [input.nodeName]: childRun.output },
      })
      return
    }

    const error =
      childRun.error ?? new Error(`Child task run [${childRun.id}] failed`)
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
  const child = await input.store.ensureChildRun({
    identity: input.identity,
    childKind: 'task',
    childName: input.taskName,
    input: nodeInput,
    parentRunId: input.run.id,
    parentNodeName: input.nodeName,
    rootRunId: input.run.rootRunId,
  })
  await dispatchTaskRunAttempt({
    store: input.store,
    attemptExecutor: input.attemptExecutor,
    runCoordinationExecutor: input.runCoordinationExecutor,
    taskName: input.taskName,
    taskRunId: child.childRun.id,
    taskInput: nodeInput,
  })
  await input.store.waitNode({
    runId: input.run.id,
    nodeName: input.nodeName,
  })
}

async function dispatchTaskRunAttempt(input: {
  readonly store: WorkflowStore
  readonly attemptExecutor: AttemptExecutor
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly taskName: string
  readonly taskRunId: string
  readonly taskInput: unknown
}) {
  await input.store.createNode({
    runId: input.taskRunId,
    name: TASK_RUN_NODE_NAME,
    kind: 'task',
  })
  await input.store.setNodeInput({
    runId: input.taskRunId,
    nodeName: TASK_RUN_NODE_NAME,
    input: input.taskInput,
  })

  await dispatchTaskAttempt({
    store: input.store,
    attemptExecutor: input.attemptExecutor,
    runCoordinationExecutor: input.runCoordinationExecutor,
    workflowName: input.taskName,
    taskName: input.taskName,
    runId: input.taskRunId,
    nodeName: TASK_RUN_NODE_NAME,
    prepareAttempt: async () => {
      const result = await input.store.ensureNodeAttempt({
        identity: {
          runId: input.taskRunId,
          nodeName: TASK_RUN_NODE_NAME,
        },
        kind: 'task',
        input: input.taskInput,
      })
      return {
        attempt: result.attempt,
        commandInput: result.created ? input.taskInput : result.attempt.input,
        created: result.created,
      }
    },
  })
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

async function failMissingChildRun(input: {
  readonly store: WorkflowStore
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly parentRunId: string
  readonly nodeName: string
  readonly childKind: 'task' | 'workflow'
  readonly childRunId: string
}) {
  const error = new Error(
    `Missing child ${input.childKind} run [${input.childRunId}]`,
  )
  await input.store.failNode({
    runId: input.parentRunId,
    nodeName: input.nodeName,
    error,
  })
  await failRunAndWakeParent({
    store: input.store,
    runCoordinationExecutor: input.runCoordinationExecutor,
    runId: input.parentRunId,
    error,
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
    if (!childRun) {
      await failMissingChildRun({
        store: input.store,
        runCoordinationExecutor: input.runCoordinationExecutor,
        parentRunId: input.run.id,
        nodeName: input.nodeName,
        childKind: 'workflow',
        childRunId: existingLink.childRunId,
      })
      return
    }

    if (!isTerminalRunStatus(childRun.status)) {
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
    await dispatchChildTaskRun({
      store: input.store,
      attemptExecutor: input.attemptExecutor,
      runCoordinationExecutor: input.runCoordinationExecutor,
      workflow: input.workflow,
      workflowCtx: input.workflowCtx,
      run: input.run,
      outputs: input.outputs,
      parentNode: existing,
      nodeName: input.node.name,
      identity,
      taskName: selected.target.name,
      resolveNodeInput: () =>
        hasStoredNodeInput(existing)
          ? existing.input
          : selected.input
            ? selected.input(input.workflowCtx, input.outputs, input.run.input)
            : input.run.input,
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

async function dispatchParallelNode(input: {
  readonly store: WorkflowStore
  readonly attemptExecutor: AttemptExecutor
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly workflow: WorkflowImplementation
  readonly workflowCtx: DependencyContext<any>
  readonly run: StoredRun
  readonly outputs: Record<string, unknown>
  readonly node: ParallelNodeImplementation
}) {
  const existing = await input.store.createNode({
    runId: input.run.id,
    name: input.node.name,
    kind: 'parallel',
  })
  if (existing.status === 'completed' || existing.status === 'failed') return

  const children = await input.store.loadNodeChildren({
    runId: input.run.id,
    nodeName: input.node.name,
  })
  const outputs: Record<string, unknown> = {}

  for (const [memberKey, member] of Object.entries(input.node.cases)) {
    const identity = {
      runId: input.run.id,
      nodeName: input.node.name,
      memberKey,
    } satisfies NodeChildIdentity

    const existingAttempt = children.attempts.find(
      (attempt) =>
        attempt.identity && sameNodeChildIdentity(attempt.identity, identity),
    )
    if (existingAttempt?.status === 'completed') {
      outputs[memberKey] = existingAttempt.output
      continue
    }
    if (existingAttempt?.status === 'failed') {
      const error =
        existingAttempt.error ??
        new Error(`Parallel member [${input.node.name}.${memberKey}] failed`)
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

    if (member.kind === 'workflow') {
      const existingLink = children.childLinks.find((link) =>
        sameNodeChildIdentity(link.identity, identity),
      )
      if (existingLink) {
        const snapshot = await input.store.loadRunSnapshot(existingLink.childRunId)
        const childRun = snapshot?.run
        if (!childRun) {
          await failMissingChildRun({
            store: input.store,
            runCoordinationExecutor: input.runCoordinationExecutor,
            parentRunId: input.run.id,
            nodeName: input.node.name,
            childKind: 'workflow',
            childRunId: existingLink.childRunId,
          })
          return
        }

        if (!isTerminalRunStatus(childRun.status)) {
          await input.runCoordinationExecutor.enqueue({
            kind: 'continueRun',
            runId: existingLink.childRunId,
            workflowName: existingLink.workflowName,
          })
          continue
        }
        if (childRun.status === 'completed') {
          outputs[memberKey] = childRun.output
          continue
        }

        const error =
          childRun.error ??
          new Error(`Parallel child workflow [${childRun.id}] ${childRun.status}`)
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

      const nodeInput = member.input
        ? member.input(input.workflowCtx, input.outputs, input.run.input)
        : input.run.input
      const child = await input.store.ensureChildWorkflowRun({
        identity,
        workflowName: member.target.name,
        input: nodeInput,
        parentRunId: input.run.id,
        parentNodeName: input.node.name,
        rootRunId: input.run.rootRunId,
      })
      await input.runCoordinationExecutor.enqueue({
        kind: 'continueRun',
        runId: child.childRun.id,
        workflowName: member.target.name,
      })
      continue
    }

    if (member.kind === 'task') {
      const existingLink = children.childLinks.find((link) =>
        sameNodeChildIdentity(link.identity, identity),
      )
      if (existingLink) {
        const snapshot = await input.store.loadRunSnapshot(existingLink.childRunId)
        const childRun = snapshot?.run
        if (!childRun) {
          await failMissingChildRun({
            store: input.store,
            runCoordinationExecutor: input.runCoordinationExecutor,
            parentRunId: input.run.id,
            nodeName: input.node.name,
            childKind: 'task',
            childRunId: existingLink.childRunId,
          })
          return
        }

        if (!isTerminalRunStatus(childRun.status)) {
          await dispatchTaskRunAttempt({
            store: input.store,
            attemptExecutor: input.attemptExecutor,
            runCoordinationExecutor: input.runCoordinationExecutor,
            taskName: member.target.name,
            taskRunId: existingLink.childRunId,
            taskInput: childRun?.input ?? input.run.input,
          })
          continue
        }
        if (childRun.status === 'completed') {
          outputs[memberKey] = childRun.output
          continue
        }

        const error =
          childRun.error ??
          new Error(`Parallel child task run [${childRun.id}] failed`)
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

      const nodeInput = member.input
        ? member.input(input.workflowCtx, input.outputs, input.run.input)
        : input.run.input
      const child = await input.store.ensureChildRun({
        identity,
        childKind: 'task',
        childName: member.target.name,
        input: nodeInput,
        parentRunId: input.run.id,
        parentNodeName: input.node.name,
        rootRunId: input.run.rootRunId,
      })
      await dispatchTaskRunAttempt({
        store: input.store,
        attemptExecutor: input.attemptExecutor,
        runCoordinationExecutor: input.runCoordinationExecutor,
        taskName: member.target.name,
        taskRunId: child.childRun.id,
        taskInput: nodeInput,
      })
      continue
    }

    if (member.kind !== 'activity') {
      throw unsupportedParallelCase(input.node.name, member)
    }

    const nodeInput = existingAttempt
      ? existingAttempt.input
      : member.input
        ? member.input(input.workflowCtx, input.outputs, input.run.input)
        : input.run.input

    await dispatchActivityAttempt({
      store: input.store,
      attemptExecutor: input.attemptExecutor,
      runCoordinationExecutor: input.runCoordinationExecutor,
      workflowName: input.workflow.workflow.name,
      activityName: member.activity.name,
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

  const expectedCount = Object.keys(input.node.cases).length
  if (Object.keys(outputs).length === expectedCount) {
    await input.store.completeNode({
      runId: input.run.id,
      nodeName: input.node.name,
      output: outputs,
    })
    await advanceWorkflowRun({
      store: input.store,
      attemptExecutor: input.attemptExecutor,
      runCoordinationExecutor: input.runCoordinationExecutor,
      workflow: input.workflow,
      workflowCtx: input.workflowCtx,
      run: input.run,
      outputs: { ...input.outputs, [input.node.name]: outputs },
    })
    return
  }

  await input.store.waitNode({
    runId: input.run.id,
    nodeName: input.node.name,
  })
}

async function dispatchMapTaskNode(input: {
  readonly store: WorkflowStore
  readonly attemptExecutor: AttemptExecutor
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly workflow: WorkflowImplementation
  readonly workflowCtx: DependencyContext<any>
  readonly run: StoredRun
  readonly outputs: Record<string, unknown>
  readonly node: MapNodeImplementation
}) {
  const existing = await input.store.createNode({
    runId: input.run.id,
    name: input.node.name,
    kind: 'mapTask',
  })
  if (existing.status === 'completed' || existing.status === 'failed') return

  let children = await input.store.loadNodeChildren({
    runId: input.run.id,
    nodeName: input.node.name,
  })
  const itemSnapshot =
    children.mapItems.length > 0
      ? children.mapItems
      : (
          await input.store.ensureMapItems({
            runId: input.run.id,
            nodeName: input.node.name,
            items: input.node.items(
              input.workflowCtx,
              input.outputs,
              input.run.input,
            ),
          })
        ).items

  if (children.mapItems.length === 0) {
    children = await input.store.loadNodeChildren({
      runId: input.run.id,
      nodeName: input.node.name,
    })
  }

  const outputItems: Array<{
    item: unknown
    index: number
    runId: string
    status?: string
    output?: unknown
    error?: unknown
  }> = []
  const concurrency = mapConcurrencyLimit(input.node)
  let activeChildren = 0
  let startedChildren = 0

  for (const item of itemSnapshot) {
    const identity = item.identity
    const existingLink = children.childLinks.find((link) =>
      sameNodeChildIdentity(link.identity, identity),
    )

    if (existingLink) {
      const snapshot = await input.store.loadRunSnapshot(existingLink.childRunId)
      const childRun = snapshot?.run
      if (!childRun) {
        await failMissingChildRun({
          store: input.store,
          runCoordinationExecutor: input.runCoordinationExecutor,
          parentRunId: input.run.id,
          nodeName: input.node.name,
          childKind: 'task',
          childRunId: existingLink.childRunId,
        })
        return
      }

      const childRunIsTerminal = isTerminalChildRun(childRun)
      if (input.node.mode !== 'start-only' && !childRunIsTerminal) {
        activeChildren += 1
      }

      if (input.node.mode === 'start-only') {
        outputItems[item.index] = {
          item: item.item,
          index: item.index,
          runId: existingLink.childRunId,
          status: childRun?.status ?? 'queued',
        }
        continue
      }

      if (!childRunIsTerminal) {
        await dispatchTaskRunAttempt({
          store: input.store,
          attemptExecutor: input.attemptExecutor,
          runCoordinationExecutor: input.runCoordinationExecutor,
          taskName: input.node.target.name,
          taskRunId: existingLink.childRunId,
          taskInput: childRun?.input ?? input.run.input,
        })
        continue
      }

      if (childRun.status === 'completed') {
        await input.store.completeMapItem({
          runId: input.run.id,
          nodeName: input.node.name,
          itemIndex: item.index,
          itemKey: item.key,
          output: childRun.output,
        })
        outputItems[item.index] = {
          item: item.item,
          index: item.index,
          runId: existingLink.childRunId,
          ...(input.node.mode === 'wait-settled'
            ? { status: childRun.status }
            : {}),
          output: childRun.output,
        }
        continue
      }

      const error =
        childRun.error ?? new Error(`Mapped task run [${childRun.id}] failed`)
      await input.store.failMapItem({
        runId: input.run.id,
        nodeName: input.node.name,
        itemIndex: item.index,
        itemKey: item.key,
        error,
      })
      if (input.node.mode === 'wait-settled') {
        outputItems[item.index] = {
          item: item.item,
          index: item.index,
          runId: existingLink.childRunId,
          status: childRun.status,
          error,
        }
        continue
      }

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

    if (input.node.mode === 'start-only') {
      if (startedChildren >= concurrency) continue
    } else if (activeChildren >= concurrency) {
      continue
    }

    const nodeInput = input.node.input(
      input.workflowCtx,
      input.outputs,
      item.item,
      input.run.input,
      item.index,
    )
    const child = await input.store.ensureChildRun({
      identity,
      childKind: 'task',
      childName: input.node.target.name,
      input: nodeInput,
      parentRunId: input.run.id,
      parentNodeName: input.node.name,
      rootRunId: input.run.rootRunId,
    })
    await dispatchTaskRunAttempt({
      store: input.store,
      attemptExecutor: input.attemptExecutor,
      runCoordinationExecutor: input.runCoordinationExecutor,
      taskName: input.node.target.name,
      taskRunId: child.childRun.id,
      taskInput: nodeInput,
    })
    if (input.node.mode === 'start-only') {
      startedChildren += 1
      outputItems[item.index] = {
        item: item.item,
        index: item.index,
        runId: child.childRun.id,
        status: child.childRun.status,
      }
    } else {
      activeChildren += 1
    }
  }

  const completedItems = outputItems.filter((item) => item !== undefined)
  if (completedItems.length === itemSnapshot.length) {
    const output = { items: completedItems }
    await input.store.completeNode({
      runId: input.run.id,
      nodeName: input.node.name,
      output,
    })
    await advanceWorkflowRun({
      store: input.store,
      attemptExecutor: input.attemptExecutor,
      runCoordinationExecutor: input.runCoordinationExecutor,
      workflow: input.workflow,
      workflowCtx: input.workflowCtx,
      run: input.run,
      outputs: { ...input.outputs, [input.node.name]: output },
    })
    return
  }

  if (input.node.mode === 'start-only' && startedChildren > 0) {
    await input.runCoordinationExecutor.enqueue({
      kind: 'continueRun',
      runId: input.run.id,
      workflowName: input.workflow.workflow.name,
    })
  }

  await input.store.waitNode({
    runId: input.run.id,
    nodeName: input.node.name,
  })
}

async function dispatchMapWorkflowNode(input: {
  readonly store: WorkflowStore
  readonly attemptExecutor: AttemptExecutor
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly workflow: WorkflowImplementation
  readonly workflowCtx: DependencyContext<any>
  readonly run: StoredRun
  readonly outputs: Record<string, unknown>
  readonly node: MapNodeImplementation
}) {
  const existing = await input.store.createNode({
    runId: input.run.id,
    name: input.node.name,
    kind: 'mapWorkflow',
  })
  if (existing.status === 'completed' || existing.status === 'failed') return

  let children = await input.store.loadNodeChildren({
    runId: input.run.id,
    nodeName: input.node.name,
  })
  const itemSnapshot =
    children.mapItems.length > 0
      ? children.mapItems
      : (
          await input.store.ensureMapItems({
            runId: input.run.id,
            nodeName: input.node.name,
            items: input.node.items(
              input.workflowCtx,
              input.outputs,
              input.run.input,
            ),
          })
        ).items

  if (children.mapItems.length === 0) {
    children = await input.store.loadNodeChildren({
      runId: input.run.id,
      nodeName: input.node.name,
    })
  }

  const outputItems: Array<{
    item: unknown
    index: number
    runId: string
    status?: string
    output?: unknown
    error?: unknown
  }> = []
  const concurrency = mapConcurrencyLimit(input.node)
  let activeChildren = 0
  let startedChildren = 0

  for (const item of itemSnapshot) {
    const identity = item.identity
    const existingLink = children.childLinks.find((link) =>
      sameNodeChildIdentity(link.identity, identity),
    )

    if (existingLink) {
      const snapshot = await input.store.loadRunSnapshot(existingLink.childRunId)
      const childRun = snapshot?.run
      if (!childRun) {
        await failMissingChildRun({
          store: input.store,
          runCoordinationExecutor: input.runCoordinationExecutor,
          parentRunId: input.run.id,
          nodeName: input.node.name,
          childKind: 'workflow',
          childRunId: existingLink.childRunId,
        })
        return
      }

      const childRunIsTerminal = isTerminalChildRun(childRun)
      if (input.node.mode !== 'start-only' && !childRunIsTerminal) {
        activeChildren += 1
      }

      if (input.node.mode === 'start-only') {
        outputItems[item.index] = {
          item: item.item,
          index: item.index,
          runId: existingLink.childRunId,
          status: childRun?.status ?? 'queued',
        }
        continue
      }

      if (!childRunIsTerminal) {
        await input.runCoordinationExecutor.enqueue({
          kind: 'continueRun',
          runId: existingLink.childRunId,
          workflowName: existingLink.workflowName,
        })
        continue
      }

      if (childRun.status === 'completed') {
        await input.store.completeMapItem({
          runId: input.run.id,
          nodeName: input.node.name,
          itemIndex: item.index,
          itemKey: item.key,
          output: childRun.output,
        })
        outputItems[item.index] = {
          item: item.item,
          index: item.index,
          runId: existingLink.childRunId,
          ...(input.node.mode === 'wait-settled'
            ? { status: childRun.status }
            : {}),
          output: childRun.output,
        }
        continue
      }

      const error =
        childRun.error ??
        new Error(`Mapped child workflow [${childRun.id}] ${childRun.status}`)
      await input.store.failMapItem({
        runId: input.run.id,
        nodeName: input.node.name,
        itemIndex: item.index,
        itemKey: item.key,
        error,
      })
      if (input.node.mode === 'wait-settled') {
        outputItems[item.index] = {
          item: item.item,
          index: item.index,
          runId: existingLink.childRunId,
          status: childRun.status,
          error,
        }
        continue
      }

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

    if (input.node.mode === 'start-only') {
      if (startedChildren >= concurrency) continue
    } else if (activeChildren >= concurrency) {
      continue
    }

    const nodeInput = input.node.input(
      input.workflowCtx,
      input.outputs,
      item.item,
      input.run.input,
      item.index,
    )
    const child = await input.store.ensureChildWorkflowRun({
      identity,
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
    if (input.node.mode === 'start-only') {
      startedChildren += 1
      outputItems[item.index] = {
        item: item.item,
        index: item.index,
        runId: child.childRun.id,
        status: child.childRun.status,
      }
    } else {
      activeChildren += 1
    }
  }

  const completedItems = outputItems.filter((item) => item !== undefined)
  if (completedItems.length === itemSnapshot.length) {
    const output = { items: completedItems }
    await input.store.completeNode({
      runId: input.run.id,
      nodeName: input.node.name,
      output,
    })
    await advanceWorkflowRun({
      store: input.store,
      attemptExecutor: input.attemptExecutor,
      runCoordinationExecutor: input.runCoordinationExecutor,
      workflow: input.workflow,
      workflowCtx: input.workflowCtx,
      run: input.run,
      outputs: { ...input.outputs, [input.node.name]: output },
    })
    return
  }

  if (input.node.mode === 'start-only' && startedChildren > 0) {
    await input.runCoordinationExecutor.enqueue({
      kind: 'continueRun',
      runId: input.run.id,
      workflowName: input.workflow.workflow.name,
    })
  }

  await input.store.waitNode({
    runId: input.run.id,
    nodeName: input.node.name,
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

function unsupportedParallelCase(
  nodeName: string,
  member: WorkflowCaseImplementation,
): Error {
  return new Error(
    `Unsupported parallel ${member.kind} member [${member.name}] in node [${nodeName}]`,
  )
}

function hasStoredNodeInput(node: { readonly input?: unknown }): boolean {
  return Object.prototype.hasOwnProperty.call(node, 'input')
}

function mapConcurrencyLimit(node: MapNodeImplementation): number {
  if (
    node.concurrency !== undefined &&
    (!Number.isInteger(node.concurrency) || node.concurrency < 1)
  ) {
    throw new Error('Map node concurrency must be a positive integer')
  }

  return node.concurrency ?? Number.POSITIVE_INFINITY
}

function isTerminalChildRun(run: StoredRun | undefined): boolean {
  return !!run && isTerminalRunStatus(run.status)
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
