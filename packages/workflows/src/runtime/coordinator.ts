import type { Container, Dependencies, DependencyContext } from '@nmtjs/core'

import type {
  ActivityNodeImplementation,
  BranchNodeImplementation,
  MapNodeImplementation,
  ParallelNodeImplementation,
  RunnableNodeImplementation,
  TaskImplementation,
  WorkflowImplementation,
  WorkflowCaseImplementation,
} from '../implement/index.ts'
import type {
  AnyTaskDefinition,
  AnyWorkflowDefinition,
  BranchCaseDefinition,
  DurationString,
  Schema,
  TaskDecodedInput,
  TaskInput,
  WorkflowDecodedInput,
  WorkflowInput,
  WorkflowNode,
} from '../types/index.ts'
import type { ContinueRunCommand } from './commands.ts'
import type { AttemptExecutor, RunCoordinationExecutor } from './executors.ts'
import type {
  NodeChildIdentity,
  StoredChildLink,
  StoredAttempt,
  StoredNode,
  StoredRun,
} from './state.ts'
import type { CreateRunInput, RunLease, WorkflowStore } from './store.ts'
import { toStoredError } from './errors.ts'
import { createWorkflowRuntimeRegistry } from './registry.ts'
import { isTerminalNodeStatus, isTerminalRunStatus } from './status.ts'
import { wakeParentRun } from './wake.ts'

const TASK_RUN_NODE_NAME = '$task'

class WorkflowUserCallbackError extends Error {
  constructor(readonly error: unknown) {
    super(error instanceof Error ? error.message : String(error))
    this.name = 'WorkflowUserCallbackError'
  }
}

class StaleRunLeaseError extends Error {
  constructor() {
    super('Stale workflow run lease')
    this.name = 'StaleRunLeaseError'
  }
}

const isWorkflowUserCallbackError = (
  error: unknown,
): error is WorkflowUserCallbackError =>
  error instanceof WorkflowUserCallbackError

const unwrapWorkflowUserCallbackError = (error: WorkflowUserCallbackError) =>
  error.error

function runWorkflowUserCallback<T>(callback: () => T): T {
  try {
    return callback()
  } catch (error) {
    throw new WorkflowUserCallbackError(error)
  }
}

export type ContinueWorkflowRunInput = {
  readonly store: WorkflowStore
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly attemptExecutor: AttemptExecutor
  readonly container: Pick<Container, 'createContext'>
  readonly workflows: readonly WorkflowImplementation<
    AnyWorkflowDefinition,
    any
  >[]
  readonly workerId: string
  readonly command: ContinueRunCommand
  readonly leaseMs?: number
}

export type ContinueWorkflowRunResult = {
  readonly status: 'processed' | 'busy' | 'ignored'
}

export type StartTaskRunInput<
  Task extends AnyTaskDefinition,
  Deps extends Dependencies = Dependencies,
> = {
  readonly store: WorkflowStore
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly attemptExecutor: AttemptExecutor
  readonly atomicStart?: WorkflowRuntimeAtomicStart
  readonly container?: Pick<Container, 'createContext'>
  readonly task: Task
  readonly implementation?: TaskImplementation<Task, Deps>
  readonly input: TaskInput<Task>
  readonly tags?: Readonly<Record<string, string>>
  readonly idempotencyKey?: readonly unknown[]
}

export type StartWorkflowRunInput<
  Workflow extends AnyWorkflowDefinition,
  Deps extends Dependencies = Dependencies,
> = {
  readonly store: WorkflowStore
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly atomicStart?: WorkflowRuntimeAtomicStart
  readonly container?: Pick<Container, 'createContext'>
  readonly workflow: Workflow
  readonly implementation?: WorkflowImplementation<Workflow, Deps>
  readonly input: WorkflowInput<Workflow>
  readonly tags?: Readonly<Record<string, string>>
  readonly idempotencyKey?: readonly unknown[]
}

type WorkflowStartMetadataInput<
  Workflow extends AnyWorkflowDefinition,
  Deps extends Dependencies,
> = Omit<StartWorkflowRunInput<Workflow, Deps>, 'input'> & {
  readonly input: WorkflowDecodedInput<Workflow>
}

export type WorkflowRuntimeAtomicStart = {
  readonly startWorkflowRun: (input: {
    readonly run: CreateRunInput
  }) => Promise<StoredRun>
  readonly startTaskRun: (input: {
    readonly run: CreateRunInput
    readonly taskName: string
    readonly taskInput: unknown
    readonly idempotencyKey?: readonly unknown[]
  }) => Promise<StoredRun>
}

export async function startWorkflowRun<
  Workflow extends AnyWorkflowDefinition,
  Deps extends Dependencies = Dependencies,
>(input: StartWorkflowRunInput<Workflow, Deps>): Promise<StoredRun> {
  assertImplementationTarget(
    input.implementation?.workflow,
    input.workflow,
    'Workflow start implementation',
  )
  const workflowInput = decodeSchemaValue(
    input.workflow.input,
    input.input,
    `workflow input [${input.workflow.name}]`,
  ) as WorkflowDecodedInput<Workflow>
  const metadata = await resolveWorkflowStartMetadata({
    ...input,
    input: workflowInput,
  })
  const runInput: CreateRunInput = {
    kind: 'workflow',
    name: input.workflow.name,
    workflowName: input.workflow.name,
    input: workflowInput,
    tags: metadata.tags,
    idempotencyKey: metadata.idempotencyKey,
  }

  if (input.atomicStart) {
    return await input.atomicStart.startWorkflowRun({ run: runInput })
  }

  const run = await input.store.createRun(runInput)

  try {
    await input.runCoordinationExecutor.enqueue({
      kind: 'continueRun',
      runId: run.id,
      workflowName: input.workflow.name,
    })
  } catch (error) {
    await input.store.failRun({
      runId: run.id,
      error,
    })
    throw error
  }

  return run
}

export async function startTaskRun<
  Task extends AnyTaskDefinition,
  Deps extends Dependencies = Dependencies,
>(input: StartTaskRunInput<Task, Deps>): Promise<StoredRun> {
  assertImplementationTarget(
    input.implementation?.task,
    input.task,
    'Task start implementation',
  )
  const taskCtx = await resolveStartContext({
    container: input.container,
    dependencies: input.implementation?.dependencies,
    needsContext:
      input.idempotencyKey === undefined && !!input.implementation?.idempotency,
    label: 'Task start idempotency',
  })
  const taskInput = decodeSchemaValue(
    input.task.input,
    input.input,
    `task input [${input.task.name}]`,
  ) as TaskDecodedInput<Task>
  const idempotencyKey =
    input.idempotencyKey ??
    resolveIdempotency(input.implementation?.idempotency, taskCtx, taskInput)

  const runInput: CreateRunInput = {
    kind: 'task',
    name: input.task.name,
    workflowName: input.task.name,
    taskName: input.task.name,
    input: taskInput,
    tags: input.tags,
    idempotencyKey,
  }

  if (input.atomicStart) {
    return await input.atomicStart.startTaskRun({
      run: runInput,
      taskName: input.task.name,
      taskInput,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    })
  }

  const run = await input.store.createRun(runInput)

  await dispatchTaskRunAttempt({
    store: input.store,
    attemptExecutor: input.attemptExecutor,
    runCoordinationExecutor: input.runCoordinationExecutor,
    taskName: input.task.name,
    taskRunId: run.id,
    taskInput,
    idempotencyKey,
    timeout: input.task.timeout,
    throwOnDispatchFailure: true,
  })

  return run
}

export async function continueWorkflowRun(
  input: ContinueWorkflowRunInput,
): Promise<ContinueWorkflowRunResult> {
  const registry = createWorkflowRuntimeRegistry({
    workflows: input.workflows,
  })
  const implementation = registry.getWorkflow(input.command.workflowName) as
    | WorkflowImplementation
    | undefined
  if (!implementation) return { status: 'ignored' }

  const leaseMs = input.leaseMs ?? 30_000
  const lease = await input.store.acquireRunLease({
    runId: input.command.runId,
    leaseMs,
  })
  if (!lease) return { status: 'busy' }
  const store = createRunLeaseFencedStore(input.store, lease, leaseMs)

  try {
    return await runWithRunLeaseRenewal(
      input.store,
      lease,
      leaseMs,
      async (): Promise<ContinueWorkflowRunResult> => {
        const snapshot = await store.loadRunSnapshot(input.command.runId)
        if (!snapshot) return { status: 'ignored' }
        if (snapshot.run.workflowName !== input.command.workflowName) {
          return { status: 'ignored' }
        }
        if (snapshot.run.status === 'cancelling') {
          await cancelRunAndWakeParent({
            store,
            attemptExecutor: input.attemptExecutor,
            runCoordinationExecutor: input.runCoordinationExecutor,
            runId: snapshot.run.id,
          })
          return { status: 'processed' }
        }
        if (isTerminalRunStatus(snapshot.run.status)) {
          await wakeParentRun({
            store,
            runCoordinationExecutor: input.runCoordinationExecutor,
            run: snapshot.run,
          })
          return { status: 'processed' }
        }

        const failedNode = snapshot.nodes.find(
          (node) => node.status === 'failed',
        )
        if (failedNode) {
          await cancelFailedFanInNodeChildren({
            store,
            attemptExecutor: input.attemptExecutor,
            runCoordinationExecutor: input.runCoordinationExecutor,
            workflow: implementation,
            runId: snapshot.run.id,
            node: failedNode,
          })
          await failRunAndWakeParent({
            store,
            runCoordinationExecutor: input.runCoordinationExecutor,
            runId: snapshot.run.id,
            error:
              failedNode.error ??
              new Error(`Workflow node [${failedNode.name}] failed`),
          })
          return { status: 'processed' }
        }

        if (snapshot.nodes.some((node) => node.status === 'cancelled')) {
          await cancelRunAndWakeParent({
            store,
            attemptExecutor: input.attemptExecutor,
            runCoordinationExecutor: input.runCoordinationExecutor,
            runId: snapshot.run.id,
          })
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
          store,
          attemptExecutor: input.attemptExecutor,
          runCoordinationExecutor: input.runCoordinationExecutor,
          workflow: implementation,
          workflowCtx: workflowCtx as DependencyContext<any>,
          run: snapshot.run,
          outputs,
        })
        return { status: 'processed' }
      },
    ).catch((error: unknown) => {
      if (error instanceof StaleRunLeaseError) {
        return { status: 'busy' } satisfies ContinueWorkflowRunResult
      }
      throw error
    })
  } finally {
    await input.store.releaseRunLease(lease)
  }
}

function createRunLeaseFencedStore(
  store: WorkflowStore,
  lease: RunLease,
  leaseMs: number,
): WorkflowStore {
  const fence = async <T>(operation: () => Promise<T>): Promise<T> => {
    const renewedLease = await store.renewRunLease(lease, leaseMs)
    if (!renewedLease) throw new StaleRunLeaseError()
    return operation()
  }

  return {
    ...store,
    createRun: (params) => fence(() => store.createRun(params)),
    createNode: (params) => fence(() => store.createNode(params)),
    setNodeInput: (params) => fence(() => store.setNodeInput(params)),
    createAttempt: (params) => fence(() => store.createAttempt(params)),
    completeCurrentAttempt: (params) =>
      fence(() => store.completeCurrentAttempt(params)),
    failCurrentAttempt: (params) =>
      fence(() => store.failCurrentAttempt(params)),
    completeNode: (params) => fence(() => store.completeNode(params)),
    failNode: (params) => fence(() => store.failNode(params)),
    completeRun: (params) => fence(() => store.completeRun(params)),
    failRun: (params) => fence(() => store.failRun(params)),
    requestRunCancellation: (params) =>
      fence(() => store.requestRunCancellation(params)),
    cancelRun: (params) => fence(() => store.cancelRun(params)),
    cancelNode: (params) => fence(() => store.cancelNode(params)),
    cancelNonTerminalRunNodes: (params) =>
      fence(() => store.cancelNonTerminalRunNodes(params)),
    ensureNodeAttempt: (params) => fence(() => store.ensureNodeAttempt(params)),
    ensureChildWorkflowRun: (params) =>
      fence(() => store.ensureChildWorkflowRun(params)),
    ensureChildRun: (params) => fence(() => store.ensureChildRun(params)),
    selectNodeCase: (params) => fence(() => store.selectNodeCase(params)),
    ensureMapItems: (params) => fence(() => store.ensureMapItems(params)),
    completeMapItem: (params) => fence(() => store.completeMapItem(params)),
    failMapItem: (params) => fence(() => store.failMapItem(params)),
    waitNode: (params) => fence(() => store.waitNode(params)),
  }
}

async function runWithRunLeaseRenewal<T>(
  store: WorkflowStore,
  lease: RunLease,
  leaseMs: number,
  handler: () => Promise<T>,
): Promise<T> {
  const intervalMs = Math.max(1, Math.floor(leaseMs / 3))
  const interval = setInterval(() => {
    void store.renewRunLease(lease, leaseMs).catch(() => {})
  }, intervalMs)
  try {
    return await handler()
  } finally {
    clearInterval(interval)
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
      throw new Error(
        `Unsupported runtime node kind [${String(nextNode.kind)}]`,
      )
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
  if (isTerminalNodeStatus(existing.status)) return
  const declaration = getWorkflowNodeDeclaration(
    input.workflow,
    input.node.name,
  )
  if (declaration.kind !== 'task') {
    throw new Error(`Workflow node [${input.node.name}] is not a task`)
  }

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
    timeout: declaration.timeout ?? declaration.task.timeout,
    inputSchema: input.node.target.input,
    inputLabel: `task input [${input.workflow.workflow.name}.${input.node.name}]`,
    resolveIdempotencyKey: () =>
      resolveIdempotency(
        input.node.idempotency,
        input.workflowCtx,
        input.outputs,
        input.run.input,
      ),
    resolveNodeInput: () =>
      hasStoredNodeInput(existing)
        ? existing.input
        : input.node.input
          ? runWorkflowUserCallback(() =>
              input.node.input!(
                input.workflowCtx,
                input.outputs,
                input.run.input,
              ),
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
  readonly timeout?: DurationString
  readonly inputSchema: Schema
  readonly inputLabel: string
  readonly resolveNodeInput: () => unknown
  readonly resolveIdempotencyKey?: () => readonly unknown[] | undefined
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
        idempotencyKey: childRun.idempotencyKey,
        timeout: input.timeout,
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

    if (childRun.status === 'cancelled') {
      await cancelNodeAndRun({
        store: input.store,
        attemptExecutor: input.attemptExecutor,
        runCoordinationExecutor: input.runCoordinationExecutor,
        runId: input.run.id,
        nodeName: input.nodeName,
      })
      return
    }

    const error =
      childRun.error ?? new Error(`Child task run [${childRun.id}] failed`)
    await failNodeAndRun({
      store: input.store,
      runCoordinationExecutor: input.runCoordinationExecutor,
      runId: input.run.id,
      nodeName: input.nodeName,
      error,
    })
    return
  }

  const nodeInput = decodeWorkflowUserSchemaValue(
    input.inputSchema,
    input.resolveNodeInput(),
    input.inputLabel,
  )
  const idempotencyKey = input.resolveIdempotencyKey?.()
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
    idempotencyKey,
  })
  await dispatchTaskRunAttempt({
    store: input.store,
    attemptExecutor: input.attemptExecutor,
    runCoordinationExecutor: input.runCoordinationExecutor,
    taskName: input.taskName,
    taskRunId: child.childRun.id,
    taskInput: nodeInput,
    idempotencyKey,
    timeout: input.timeout,
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
  readonly idempotencyKey?: readonly unknown[]
  readonly timeout?: DurationString
  readonly throwOnDispatchFailure?: boolean
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
    timeout: input.timeout,
    throwOnDispatchFailure: input.throwOnDispatchFailure,
    prepareAttempt: async () => {
      const result = await input.store.ensureNodeAttempt({
        identity: {
          runId: input.taskRunId,
          nodeName: TASK_RUN_NODE_NAME,
        },
        kind: 'task',
        input: input.taskInput,
        idempotencyKey: input.idempotencyKey,
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

async function cancelRunAndWakeParent(input: {
  readonly store: WorkflowStore
  readonly attemptExecutor: AttemptExecutor
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly runId: string
}) {
  const cancelled = await cancelRunTree(input)
  await wakeParentRun({
    store: input.store,
    runCoordinationExecutor: input.runCoordinationExecutor,
    run: cancelled,
  })
}

async function cancelRunTree(input: {
  readonly store: WorkflowStore
  readonly attemptExecutor: AttemptExecutor
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly runId: string
}): Promise<StoredRun | undefined> {
  const snapshot = await input.store.loadRunSnapshot(input.runId)
  if (!snapshot) return undefined
  if (isTerminalRunStatus(snapshot.run.status)) return snapshot.run

  await input.store.requestRunCancellation({ runId: input.runId })
  await input.store.cancelNonTerminalRunNodes({ runId: input.runId })

  for (const link of snapshot.childLinks) {
    const childSnapshot = await input.store.loadRunSnapshot(link.childRunId)
    if (!childSnapshot || isTerminalRunStatus(childSnapshot.run.status))
      continue
    await input.store.requestRunCancellation({ runId: link.childRunId })
    if (childSnapshot.run.kind === 'workflow') {
      await input.runCoordinationExecutor.enqueue({
        kind: 'continueRun',
        runId: link.childRunId,
        workflowName: link.workflowName,
      })
    }
    await cancelRunTree({ ...input, runId: link.childRunId })
  }

  await input.attemptExecutor.deleteUnclaimed({ runId: input.runId })
  return await input.store.cancelRun({ runId: input.runId })
}

async function cancelNodeChildRunsAndCommands(input: {
  readonly store: WorkflowStore
  readonly attemptExecutor: AttemptExecutor
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly runId: string
  readonly nodeName: string
}) {
  const children = await input.store.loadNodeChildren({
    runId: input.runId,
    nodeName: input.nodeName,
  })
  for (const link of children.childLinks) {
    const childSnapshot = await input.store.loadRunSnapshot(link.childRunId)
    if (!childSnapshot || isTerminalRunStatus(childSnapshot.run.status))
      continue
    await input.store.requestRunCancellation({ runId: link.childRunId })
    if (childSnapshot.run.kind === 'workflow') {
      await input.runCoordinationExecutor.enqueue({
        kind: 'continueRun',
        runId: link.childRunId,
        workflowName: link.workflowName,
      })
    }
    await cancelRunTree({ ...input, runId: link.childRunId })
  }
  await input.attemptExecutor.deleteUnclaimed({ runId: input.runId })
}

async function cancelFailedFanInNodeChildren(input: {
  readonly store: WorkflowStore
  readonly attemptExecutor: AttemptExecutor
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly workflow: WorkflowImplementation
  readonly runId: string
  readonly node: StoredNode
}) {
  if (!shouldCancelFailedFanInNode(input.workflow, input.node)) return
  await cancelNodeChildRunsAndCommands({
    store: input.store,
    attemptExecutor: input.attemptExecutor,
    runCoordinationExecutor: input.runCoordinationExecutor,
    runId: input.runId,
    nodeName: input.node.name,
  })
}

function shouldCancelFailedFanInNode(
  workflow: WorkflowImplementation,
  node: StoredNode,
): boolean {
  const declaration = getWorkflowNodeDeclaration(workflow, node.name)
  if (declaration.kind === 'parallel') return true
  if (declaration.kind === 'mapTask' || declaration.kind === 'mapWorkflow') {
    return declaration.mode !== 'wait-settled'
  }
  return false
}

async function failNodeAndRun(input: {
  readonly store: WorkflowStore
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly runId: string
  readonly nodeName: string
  readonly error: unknown
}) {
  await input.store.failNode({
    runId: input.runId,
    nodeName: input.nodeName,
    error: input.error,
  })
  await failRunAndWakeParent({
    store: input.store,
    runCoordinationExecutor: input.runCoordinationExecutor,
    runId: input.runId,
    error: input.error,
  })
}

async function cancelNodeAndRun(input: {
  readonly store: WorkflowStore
  readonly attemptExecutor: AttemptExecutor
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly runId: string
  readonly nodeName: string
}) {
  await input.store.cancelNode({
    runId: input.runId,
    nodeName: input.nodeName,
  })
  await cancelRunAndWakeParent({
    store: input.store,
    attemptExecutor: input.attemptExecutor,
    runCoordinationExecutor: input.runCoordinationExecutor,
    runId: input.runId,
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
  await failNodeAndRun({
    store: input.store,
    runCoordinationExecutor: input.runCoordinationExecutor,
    runId: input.parentRunId,
    nodeName: input.nodeName,
    error,
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
  if (isTerminalNodeStatus(existing.status)) return

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
    inputSchema: input.node.target.input,
    inputLabel: `workflow input [${input.workflow.workflow.name}.${input.node.name}]`,
    resolveIdempotencyKey: () =>
      resolveIdempotency(
        input.node.idempotency,
        input.workflowCtx,
        input.outputs,
        input.run.input,
      ),
    resolveNodeInput: () =>
      hasStoredNodeInput(existing)
        ? existing.input
        : input.node.input
          ? runWorkflowUserCallback(() =>
              input.node.input!(
                input.workflowCtx,
                input.outputs,
                input.run.input,
              ),
            )
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
  readonly inputSchema: Schema
  readonly inputLabel: string
  readonly resolveNodeInput: () => unknown
  readonly resolveIdempotencyKey?: () => readonly unknown[] | undefined
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
      const nextOutputs = {
        ...input.outputs,
        [input.nodeName]: childRun.output,
      }
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

    if (childRun.status === 'cancelled') {
      await cancelNodeAndRun({
        store: input.store,
        attemptExecutor: input.attemptExecutor,
        runCoordinationExecutor: input.runCoordinationExecutor,
        runId: input.run.id,
        nodeName: input.nodeName,
      })
      return
    }

    const error =
      childRun.error ??
      new Error(`Child workflow [${childRun.id}] ${childRun.status}`)
    await failNodeAndRun({
      store: input.store,
      runCoordinationExecutor: input.runCoordinationExecutor,
      runId: input.run.id,
      nodeName: input.nodeName,
      error,
    })
    return
  }

  const nodeInput = decodeWorkflowUserSchemaValue(
    input.inputSchema,
    input.resolveNodeInput(),
    input.inputLabel,
  )
  const idempotencyKey = input.resolveIdempotencyKey?.()
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
    idempotencyKey,
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
  if (isTerminalNodeStatus(existing.status)) return
  if (existing.status === 'running' || existing.status === 'waiting') {
    const children = await input.store.loadNodeChildren({
      runId: input.runId,
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
                input.workflowInput,
              ),
            )
          : input.workflowInput,
        `activity input [${input.workflow.workflow.name}.${input.node.name}]`,
      )

  if (!hasStoredNodeInput(existing)) {
    await input.store.setNodeInput({
      runId: input.runId,
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
    runId: input.runId,
    nodeName: input.node.name,
    prepareAttempt: async () => ({
      attempt: await input.store.createAttempt({
        runId: input.runId,
        nodeName: input.node.name,
        input: nodeInput,
        idempotencyKey: resolveIdempotency(
          input.node.idempotency,
          input.workflowCtx,
          input.outputs,
          input.workflowInput,
        ),
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
  if (isTerminalNodeStatus(existing.status)) return

  let caseKey = existing.selectedCase
  if (caseKey === undefined) {
    try {
      caseKey = input.node.select(
        input.workflowCtx,
        input.outputs,
        input.run.input,
      )
    } catch (error) {
      await failNodeAndRun({
        store: input.store,
        runCoordinationExecutor: input.runCoordinationExecutor,
        runId: input.run.id,
        nodeName: input.node.name,
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
    const error = new Error(
      `Unknown branch case [${input.node.name}.${caseKey}]`,
    )
    await failNodeAndRun({
      store: input.store,
      runCoordinationExecutor: input.runCoordinationExecutor,
      runId: input.run.id,
      nodeName: input.node.name,
      error,
    })
    return
  }
  const declaration = getWorkflowNodeDeclaration(
    input.workflow,
    input.node.name,
  )
  if (declaration.kind !== 'branch') {
    throw new Error(`Workflow node [${input.node.name}] is not a branch`)
  }
  const selectedDeclaration = declaration.cases[caseKey]
  if (!selectedDeclaration) {
    throw new Error(
      `Missing branch case declaration [${input.node.name}.${caseKey}]`,
    )
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
      inputSchema: selected.target.input,
      inputLabel: `workflow input [${input.workflow.workflow.name}.${input.node.name}.${caseKey}]`,
      resolveIdempotencyKey: () =>
        resolveIdempotency(
          selected.idempotency,
          input.workflowCtx,
          input.outputs,
          input.run.input,
        ),
      resolveNodeInput: () =>
        hasStoredNodeInput(existing)
          ? existing.input
          : selected.input
            ? runWorkflowUserCallback(() =>
                selected.input!(
                  input.workflowCtx,
                  input.outputs,
                  input.run.input,
                ),
              )
            : input.run.input,
    })
    return
  }

  if (selected.kind === 'task') {
    if (selectedDeclaration.kind !== 'task') {
      throw new Error(
        `Branch case [${input.node.name}.${caseKey}] is not a task`,
      )
    }
    const taskDeclaration = selectedDeclaration as BranchCaseDefinition<
      'task',
      unknown,
      unknown,
      AnyTaskDefinition
    >
    const taskTarget = selected.target as AnyTaskDefinition
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
      taskName: taskTarget.name,
      timeout: taskDeclaration.timeout ?? taskTarget.timeout,
      inputSchema: taskTarget.input,
      inputLabel: `task input [${input.workflow.workflow.name}.${input.node.name}.${caseKey}]`,
      resolveIdempotencyKey: () =>
        resolveIdempotency(
          selected.idempotency,
          input.workflowCtx,
          input.outputs,
          input.run.input,
        ),
      resolveNodeInput: () =>
        hasStoredNodeInput(existing)
          ? existing.input
          : selected.input
            ? runWorkflowUserCallback(() =>
                selected.input!(
                  input.workflowCtx,
                  input.outputs,
                  input.run.input,
                ),
              )
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

  if (selectedDeclaration.kind !== 'activity') {
    throw new Error(
      `Branch case [${input.node.name}.${caseKey}] is not an activity`,
    )
  }
  const selectedActivityDeclaration =
    selectedDeclaration as BranchCaseDefinition<'activity'>
  const nodeInput = decodeWorkflowUserSchemaValue(
    selectedActivityDeclaration.input,
    selected.input
      ? runWorkflowUserCallback(() =>
          selected.input!(input.workflowCtx, input.outputs, input.run.input),
        )
      : input.run.input,
    `activity input [${input.workflow.workflow.name}.${input.node.name}.${caseKey}]`,
  )
  const idempotencyKey = resolveIdempotency(
    selected.idempotency,
    input.workflowCtx,
    input.outputs,
    input.run.input,
  )

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
        idempotencyKey,
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
  if (isTerminalNodeStatus(existing.status)) return

  const children = await input.store.loadNodeChildren({
    runId: input.run.id,
    nodeName: input.node.name,
  })
  const outputs: Record<string, unknown> = {}
  const declaration = getWorkflowNodeDeclaration(
    input.workflow,
    input.node.name,
  )
  if (declaration.kind !== 'parallel') {
    throw new Error(`Workflow node [${input.node.name}] is not parallel`)
  }

  for (const [memberKey, member] of Object.entries(input.node.cases)) {
    const memberDeclaration = declaration.cases[memberKey]
    if (!memberDeclaration) {
      throw new Error(
        `Missing parallel member declaration [${input.node.name}.${memberKey}]`,
      )
    }
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
      await cancelNodeChildRunsAndCommands({
        store: input.store,
        attemptExecutor: input.attemptExecutor,
        runCoordinationExecutor: input.runCoordinationExecutor,
        runId: input.run.id,
        nodeName: input.node.name,
      })
      await failNodeAndRun({
        store: input.store,
        runCoordinationExecutor: input.runCoordinationExecutor,
        runId: input.run.id,
        nodeName: input.node.name,
        error,
      })
      return
    }

    if (member.kind === 'workflow') {
      const existingLink = children.childLinks.find((link) =>
        sameNodeChildIdentity(link.identity, identity),
      )
      if (existingLink) {
        const snapshot = await input.store.loadRunSnapshot(
          existingLink.childRunId,
        )
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
        if (childRun.status === 'cancelled') {
          await cancelNodeAndRun({
            store: input.store,
            attemptExecutor: input.attemptExecutor,
            runCoordinationExecutor: input.runCoordinationExecutor,
            runId: input.run.id,
            nodeName: input.node.name,
          })
          return
        }

        const error =
          childRun.error ??
          new Error(
            `Parallel child workflow [${childRun.id}] ${childRun.status}`,
          )
        await cancelNodeChildRunsAndCommands({
          store: input.store,
          attemptExecutor: input.attemptExecutor,
          runCoordinationExecutor: input.runCoordinationExecutor,
          runId: input.run.id,
          nodeName: input.node.name,
        })
        await failNodeAndRun({
          store: input.store,
          runCoordinationExecutor: input.runCoordinationExecutor,
          runId: input.run.id,
          nodeName: input.node.name,
          error,
        })
        return
      }

      const nodeInput = decodeWorkflowUserSchemaValue(
        member.target.input,
        member.input
          ? runWorkflowUserCallback(() =>
              member.input!(input.workflowCtx, input.outputs, input.run.input),
            )
          : input.run.input,
        `workflow input [${input.workflow.workflow.name}.${input.node.name}.${memberKey}]`,
      )
      const idempotencyKey = resolveIdempotency(
        member.idempotency,
        input.workflowCtx,
        input.outputs,
        input.run.input,
      )
      const child = await input.store.ensureChildWorkflowRun({
        identity,
        workflowName: member.target.name,
        input: nodeInput,
        parentRunId: input.run.id,
        parentNodeName: input.node.name,
        rootRunId: input.run.rootRunId,
        idempotencyKey,
      })
      await input.runCoordinationExecutor.enqueue({
        kind: 'continueRun',
        runId: child.childRun.id,
        workflowName: member.target.name,
      })
      continue
    }

    if (member.kind === 'task') {
      if (memberDeclaration.kind !== 'task') {
        throw new Error(
          `Parallel member [${input.node.name}.${memberKey}] is not a task`,
        )
      }
      const taskDeclaration = memberDeclaration as BranchCaseDefinition<
        'task',
        unknown,
        unknown,
        AnyTaskDefinition
      >
      const taskTarget = member.target as AnyTaskDefinition
      const existingLink = children.childLinks.find((link) =>
        sameNodeChildIdentity(link.identity, identity),
      )
      if (existingLink) {
        const snapshot = await input.store.loadRunSnapshot(
          existingLink.childRunId,
        )
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
            taskName: taskTarget.name,
            taskRunId: existingLink.childRunId,
            taskInput: childRun?.input ?? input.run.input,
            idempotencyKey: childRun.idempotencyKey,
            timeout: taskDeclaration.timeout ?? taskTarget.timeout,
          })
          continue
        }
        if (childRun.status === 'completed') {
          outputs[memberKey] = childRun.output
          continue
        }
        if (childRun.status === 'cancelled') {
          await cancelNodeAndRun({
            store: input.store,
            attemptExecutor: input.attemptExecutor,
            runCoordinationExecutor: input.runCoordinationExecutor,
            runId: input.run.id,
            nodeName: input.node.name,
          })
          return
        }

        const error =
          childRun.error ??
          new Error(`Parallel child task run [${childRun.id}] failed`)
        await cancelNodeChildRunsAndCommands({
          store: input.store,
          attemptExecutor: input.attemptExecutor,
          runCoordinationExecutor: input.runCoordinationExecutor,
          runId: input.run.id,
          nodeName: input.node.name,
        })
        await failNodeAndRun({
          store: input.store,
          runCoordinationExecutor: input.runCoordinationExecutor,
          runId: input.run.id,
          nodeName: input.node.name,
          error,
        })
        return
      }

      const nodeInput = decodeWorkflowUserSchemaValue(
        member.target.input,
        member.input
          ? runWorkflowUserCallback(() =>
              member.input!(input.workflowCtx, input.outputs, input.run.input),
            )
          : input.run.input,
        `task input [${input.workflow.workflow.name}.${input.node.name}.${memberKey}]`,
      )
      const idempotencyKey = resolveIdempotency(
        member.idempotency,
        input.workflowCtx,
        input.outputs,
        input.run.input,
      )
      const child = await input.store.ensureChildRun({
        identity,
        childKind: 'task',
        childName: taskTarget.name,
        input: nodeInput,
        parentRunId: input.run.id,
        parentNodeName: input.node.name,
        rootRunId: input.run.rootRunId,
        idempotencyKey,
      })
      await dispatchTaskRunAttempt({
        store: input.store,
        attemptExecutor: input.attemptExecutor,
        runCoordinationExecutor: input.runCoordinationExecutor,
        taskName: taskTarget.name,
        taskRunId: child.childRun.id,
        taskInput: nodeInput,
        idempotencyKey,
        timeout: taskDeclaration.timeout ?? taskTarget.timeout,
      })
      continue
    }

    if (member.kind !== 'activity') {
      throw unsupportedParallelCase(input.node.name, member)
    }

    if (memberDeclaration.kind !== 'activity') {
      throw new Error(
        `Parallel member [${input.node.name}.${memberKey}] is not an activity`,
      )
    }
    const activityMemberDeclaration =
      memberDeclaration as BranchCaseDefinition<'activity'>
    const nodeInput = existingAttempt
      ? existingAttempt.input
      : decodeWorkflowUserSchemaValue(
          activityMemberDeclaration.input,
          member.input
            ? runWorkflowUserCallback(() =>
                member.input!(
                  input.workflowCtx,
                  input.outputs,
                  input.run.input,
                ),
              )
            : input.run.input,
          `activity input [${input.workflow.workflow.name}.${input.node.name}.${memberKey}]`,
        )
    const idempotencyKey =
      existingAttempt?.idempotencyKey ??
      resolveIdempotency(
        member.idempotency,
        input.workflowCtx,
        input.outputs,
        input.run.input,
      )

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
          idempotencyKey,
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

type MapTaskDeclaration = Extract<WorkflowNode, { readonly kind: 'mapTask' }>

type MapWorkflowDeclaration = Extract<
  WorkflowNode,
  { readonly kind: 'mapWorkflow' }
>

async function dispatchMapTaskNode(input: MapDispatchInput) {
  await dispatchMapRunNode<MapTaskDeclaration>(input, {
    kind: 'mapTask',
    childKind: 'task',
    inputLabel: 'task',
    redispatchActiveChild: async ({ childRun, existingLink, declaration }) => {
      await dispatchTaskRunAttempt({
        store: input.store,
        attemptExecutor: input.attemptExecutor,
        runCoordinationExecutor: input.runCoordinationExecutor,
        taskName: input.node.target.name,
        taskRunId: existingLink.childRunId,
        taskInput: childRun.input ?? input.run.input,
        idempotencyKey: childRun.idempotencyKey,
        timeout: declaration.timeout ?? declaration.task.timeout,
      })
    },
    startChild: async ({
      identity,
      nodeInput,
      idempotencyKey,
      declaration,
    }) => {
      const child = await input.store.ensureChildRun({
        identity,
        childKind: 'task',
        childName: input.node.target.name,
        input: nodeInput,
        parentRunId: input.run.id,
        parentNodeName: input.node.name,
        rootRunId: input.run.rootRunId,
        idempotencyKey,
      })
      await dispatchTaskRunAttempt({
        store: input.store,
        attemptExecutor: input.attemptExecutor,
        runCoordinationExecutor: input.runCoordinationExecutor,
        taskName: input.node.target.name,
        taskRunId: child.childRun.id,
        taskInput: nodeInput,
        idempotencyKey,
        timeout: declaration.timeout ?? declaration.task.timeout,
      })
      return child.childRun
    },
    failedChildError: (childRun) =>
      childRun.error ?? new Error(`Mapped task run [${childRun.id}] failed`),
  })
}

async function dispatchMapWorkflowNode(input: MapDispatchInput) {
  await dispatchMapRunNode<MapWorkflowDeclaration>(input, {
    kind: 'mapWorkflow',
    childKind: 'workflow',
    inputLabel: 'workflow',
    redispatchActiveChild: async ({ existingLink }) => {
      await input.runCoordinationExecutor.enqueue({
        kind: 'continueRun',
        runId: existingLink.childRunId,
        workflowName: existingLink.workflowName,
      })
    },
    startChild: async ({ identity, nodeInput, idempotencyKey }) => {
      const child = await input.store.ensureChildWorkflowRun({
        identity,
        workflowName: input.node.target.name,
        input: nodeInput,
        parentRunId: input.run.id,
        parentNodeName: input.node.name,
        rootRunId: input.run.rootRunId,
        idempotencyKey,
      })
      await input.runCoordinationExecutor.enqueue({
        kind: 'continueRun',
        runId: child.childRun.id,
        workflowName: input.node.target.name,
      })
      return child.childRun
    },
    failedChildError: (childRun) =>
      childRun.error ??
      new Error(`Mapped child workflow [${childRun.id}] ${childRun.status}`),
  })
}

type MapDispatchInput = {
  readonly store: WorkflowStore
  readonly attemptExecutor: AttemptExecutor
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly workflow: WorkflowImplementation
  readonly workflowCtx: DependencyContext<any>
  readonly run: StoredRun
  readonly outputs: Record<string, unknown>
  readonly node: MapNodeImplementation
}

type MapRunNodeDeclaration = Extract<
  WorkflowNode,
  { readonly kind: 'mapTask' | 'mapWorkflow' }
>

type MapRunNodeCallbacks<Declaration extends MapRunNodeDeclaration> = {
  readonly kind: Declaration['kind']
  readonly childKind: 'task' | 'workflow'
  readonly inputLabel: 'task' | 'workflow'
  readonly redispatchActiveChild: (input: {
    readonly existingLink: StoredChildLink
    readonly childRun: StoredRun
    readonly declaration: Declaration
  }) => Promise<void>
  readonly startChild: (input: {
    readonly identity: NodeChildIdentity
    readonly nodeInput: unknown
    readonly idempotencyKey?: readonly unknown[]
    readonly declaration: Declaration
  }) => Promise<StoredRun>
  readonly failedChildError: (childRun: StoredRun) => unknown
}

async function dispatchMapRunNode<Declaration extends MapRunNodeDeclaration>(
  input: MapDispatchInput,
  callbacks: MapRunNodeCallbacks<Declaration>,
) {
  const existing = await input.store.createNode({
    runId: input.run.id,
    name: input.node.name,
    kind: callbacks.kind,
  })
  if (isTerminalNodeStatus(existing.status)) return

  let children = await input.store.loadNodeChildren({
    runId: input.run.id,
    nodeName: input.node.name,
  })
  const declaration = getWorkflowNodeDeclaration(
    input.workflow,
    input.node.name,
  )
  if (declaration.kind !== callbacks.kind) {
    throw new Error(
      `Workflow node [${input.node.name}] is not a ${callbacks.kind}`,
    )
  }
  const typedDeclaration = declaration as Declaration
  const itemSnapshot =
    children.mapItems.length > 0
      ? children.mapItems
      : (
          await input.store.ensureMapItems({
            runId: input.run.id,
            nodeName: input.node.name,
            items: decodeMapItems(
              typedDeclaration.item,
              runWorkflowUserCallback(() =>
                input.node.items(
                  input.workflowCtx,
                  input.outputs,
                  input.run.input,
                ),
              ),
              `map item [${input.workflow.workflow.name}.${input.node.name}]`,
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
      const snapshot = await input.store.loadRunSnapshot(
        existingLink.childRunId,
      )
      const childRun = snapshot?.run
      if (!childRun) {
        await failMissingChildRun({
          store: input.store,
          runCoordinationExecutor: input.runCoordinationExecutor,
          parentRunId: input.run.id,
          nodeName: input.node.name,
          childKind: callbacks.childKind,
          childRunId: existingLink.childRunId,
        })
        return
      }

      const childRunIsTerminal = isTerminalRunStatus(childRun.status)
      if (input.node.mode !== 'start-only' && !childRunIsTerminal) {
        activeChildren += 1
      }

      if (input.node.mode === 'start-only') {
        outputItems[item.index] = {
          item: item.item,
          index: item.index,
          runId: existingLink.childRunId,
          status: childRun.status,
        }
        continue
      }

      if (!childRunIsTerminal) {
        await callbacks.redispatchActiveChild({
          existingLink,
          childRun,
          declaration: typedDeclaration,
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

      if (
        childRun.status === 'cancelled' &&
        input.node.mode !== 'wait-settled'
      ) {
        await cancelNodeAndRun({
          store: input.store,
          attemptExecutor: input.attemptExecutor,
          runCoordinationExecutor: input.runCoordinationExecutor,
          runId: input.run.id,
          nodeName: input.node.name,
        })
        return
      }

      const error = callbacks.failedChildError(childRun)
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
          error: toStoredError(error),
        }
        continue
      }

      await cancelNodeChildRunsAndCommands({
        store: input.store,
        attemptExecutor: input.attemptExecutor,
        runCoordinationExecutor: input.runCoordinationExecutor,
        runId: input.run.id,
        nodeName: input.node.name,
      })
      await failNodeAndRun({
        store: input.store,
        runCoordinationExecutor: input.runCoordinationExecutor,
        runId: input.run.id,
        nodeName: input.node.name,
        error,
      })
      return
    }

    if (input.node.mode === 'start-only') {
      if (startedChildren >= concurrency) continue
    } else if (activeChildren >= concurrency) {
      continue
    }

    const nodeInput = decodeWorkflowUserSchemaValue(
      input.node.target.input,
      runWorkflowUserCallback(() =>
        input.node.input(
          input.workflowCtx,
          input.outputs,
          item.item,
          input.run.input,
          item.index,
        ),
      ),
      `${callbacks.inputLabel} input [${input.workflow.workflow.name}.${input.node.name}.${item.index}]`,
    )
    const idempotencyKey = resolveIdempotency(
      input.node.idempotency,
      input.workflowCtx,
      input.outputs,
      item.item,
      input.run.input,
      item.index,
    )
    const childRun = await callbacks.startChild({
      identity,
      nodeInput,
      idempotencyKey,
      declaration: typedDeclaration,
    })
    if (input.node.mode === 'start-only') {
      startedChildren += 1
      outputItems[item.index] = {
        item: item.item,
        index: item.index,
        runId: childRun.id,
        status: childRun.status,
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

function decodeSchemaValue(
  schema: Schema,
  value: unknown,
  label: string,
): unknown {
  try {
    return schema.decode(value as never)
  } catch (error) {
    throw new Error(`Invalid ${label}`, { cause: error })
  }
}

function decodeWorkflowUserSchemaValue(
  schema: Schema,
  value: unknown,
  label: string,
): unknown {
  return runWorkflowUserCallback(() => decodeSchemaValue(schema, value, label))
}

function decodeMapItems(
  itemSchema: Schema,
  items: readonly unknown[],
  label: string,
): readonly unknown[] {
  return runWorkflowUserCallback(() =>
    items.map((item, index) =>
      decodeSchemaValue(itemSchema, item, `${label}.${index}`),
    ),
  )
}

function getWorkflowNodeDeclaration(
  workflow: WorkflowImplementation,
  nodeName: string,
): WorkflowNode {
  const node = workflow.workflow.nodes.find(
    (candidate) => candidate.name === nodeName,
  )
  if (!node) {
    throw new Error(
      `Missing workflow node declaration [${workflow.workflow.name}.${nodeName}]`,
    )
  }
  return node
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

async function resolveWorkflowStartMetadata<
  Workflow extends AnyWorkflowDefinition,
  Deps extends Dependencies,
>(
  input: WorkflowStartMetadataInput<Workflow, Deps>,
): Promise<{
  readonly tags?: Readonly<Record<string, string>>
  readonly idempotencyKey?: readonly unknown[]
}> {
  const needsContext =
    (input.tags === undefined && !!input.implementation?.tags) ||
    (input.idempotencyKey === undefined && !!input.implementation?.idempotency)
  const ctx = await resolveStartContext<Deps>({
    container: input.container,
    dependencies: input.implementation?.dependencies,
    needsContext,
    label: 'Workflow start metadata',
  })

  return {
    tags: input.tags ?? input.implementation?.tags?.(ctx, input.input),
    idempotencyKey:
      input.idempotencyKey ??
      resolveIdempotency(input.implementation?.idempotency, ctx, input.input),
  }
}

async function resolveStartContext<Deps extends Dependencies>(input: {
  readonly container: Pick<Container, 'createContext'> | undefined
  readonly dependencies: Deps | undefined
  readonly needsContext: boolean
  readonly label: string
}): Promise<DependencyContext<Deps>> {
  if (!input.needsContext) return {} as DependencyContext<Deps>
  if (!input.container) {
    throw new Error(`${input.label} requires a container`)
  }

  return (await input.container.createContext(
    input.dependencies ?? {},
  )) as DependencyContext<Deps>
}

function resolveIdempotency(
  idempotency: unknown,
  ...args: readonly unknown[]
): readonly unknown[] | undefined {
  if (!idempotency) return undefined
  if (typeof idempotency === 'function') {
    return runWorkflowUserCallback(
      () => idempotency(...args) as readonly unknown[],
    )
  }

  if (
    typeof idempotency === 'object' &&
    idempotency !== null &&
    'key' in idempotency &&
    typeof idempotency.key === 'function'
  ) {
    const key = idempotency.key
    return runWorkflowUserCallback(() => key(...args) as readonly unknown[])
  }

  throw new Error('Invalid idempotency definition')
}

function assertImplementationTarget(
  implementationTarget: { readonly name: string } | undefined,
  target: { readonly name: string },
  label: string,
) {
  if (implementationTarget && implementationTarget.name !== target.name) {
    throw new Error(
      `${label} [${implementationTarget.name}] does not match [${target.name}]`,
    )
  }
}

async function dispatchActivityAttempt(input: {
  readonly store: WorkflowStore
  readonly attemptExecutor: AttemptExecutor
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly workflowName: string
  readonly activityName: string
  readonly runId: string
  readonly nodeName: string
  readonly throwOnDispatchFailure?: boolean
  readonly prepareAttempt: () => Promise<{
    readonly attempt: StoredAttempt
    readonly commandInput: unknown
    readonly created: boolean
  }>
}) {
  await dispatchPreparedAttempt(input, async (attempt, commandInput) => {
    await input.attemptExecutor.dispatchActivity({
      kind: 'activityAttempt',
      workflowName: input.workflowName,
      activityName: input.activityName,
      runId: input.runId,
      nodeName: input.nodeName,
      attemptId: attempt.id,
      leaseToken: attempt.leaseToken!,
      input: commandInput,
      ...(attempt.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: attempt.idempotencyKey }),
    })
  })
}

async function dispatchTaskAttempt(input: {
  readonly store: WorkflowStore
  readonly attemptExecutor: AttemptExecutor
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly workflowName: string
  readonly taskName: string
  readonly runId: string
  readonly nodeName: string
  readonly timeout?: DurationString
  readonly throwOnDispatchFailure?: boolean
  readonly prepareAttempt: () => Promise<{
    readonly attempt: StoredAttempt
    readonly commandInput: unknown
    readonly created: boolean
  }>
}) {
  await dispatchPreparedAttempt(input, async (attempt, commandInput) => {
    await input.attemptExecutor.dispatchTask({
      kind: 'taskAttempt',
      workflowName: input.workflowName,
      taskName: input.taskName,
      runId: input.runId,
      nodeName: input.nodeName,
      attemptId: attempt.id,
      leaseToken: attempt.leaseToken!,
      input: commandInput,
      ...(attempt.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: attempt.idempotencyKey }),
      ...(input.timeout === undefined ? {} : { timeout: input.timeout }),
    })
  })
}

async function dispatchPreparedAttempt(
  input: {
    readonly store: WorkflowStore
    readonly runCoordinationExecutor: RunCoordinationExecutor
    readonly runId: string
    readonly nodeName: string
    readonly throwOnDispatchFailure?: boolean
    readonly prepareAttempt: () => Promise<{
      readonly attempt: StoredAttempt
      readonly commandInput: unknown
      readonly created: boolean
    }>
  },
  dispatch: (attempt: StoredAttempt, commandInput: unknown) => Promise<void>,
) {
  const { attempt, commandInput, created } = await input.prepareAttempt()

  if (!created && attempt.status !== 'started') return

  try {
    await dispatch(attempt, commandInput)
  } catch (error) {
    if (input.throwOnDispatchFailure) {
      await input.store.failCurrentAttempt({
        attemptId: attempt.id,
        leaseToken: attempt.leaseToken!,
        error,
      })
      await failNodeAndRun({
        store: input.store,
        runCoordinationExecutor: input.runCoordinationExecutor,
        runId: input.runId,
        nodeName: input.nodeName,
        error,
      })
    }
    throw error
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
