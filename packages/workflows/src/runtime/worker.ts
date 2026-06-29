import type { Container, DependencyContext } from '@nmtjs/core'

import type {
  ActivityNodeImplementation,
  BranchNodeImplementation,
  ParallelNodeImplementation,
  TaskImplementation,
  WorkflowImplementation,
  WorkflowCaseImplementation,
} from '../implement/index.ts'
import type {
  ActivityAttemptCommand,
  ClaimedAttempt,
  TaskAttemptCommand,
} from './commands.ts'
import type { AttemptExecutor, RunCoordinationExecutor } from './executors.ts'
import { createWorkflowRuntimeRegistry } from './registry.ts'
import type { StoredAttempt, StoredNode } from './state.ts'
import type { WorkflowStore } from './store.ts'

type ActivityAttemptNode =
  | ActivityNodeImplementation
  | Extract<WorkflowCaseImplementation, { readonly kind: 'activity' }>

export async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('Concurrency must be a positive integer')
  }

  let nextIndex = 0

  async function runWorker(): Promise<void> {
    while (nextIndex < items.length) {
      const item = items[nextIndex]
      nextIndex += 1
      await worker(item)
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, runWorker),
  )
}

export type RunActivityAttemptInput = {
  readonly store: WorkflowStore
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly attemptExecutor: AttemptExecutor
  readonly workflows: readonly WorkflowImplementation<any, any>[]
  readonly workerId: string
  readonly claimed: ClaimedAttempt
  readonly container: Pick<Container, 'createContext'>
}

export type RunTaskAttemptInput = {
  readonly store: WorkflowStore
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly attemptExecutor: AttemptExecutor
  readonly tasks: readonly TaskImplementation[]
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

  const snapshot = await input.store.loadRunSnapshot(command.runId)
  const storedNode = snapshot?.nodes.find(
    (node) => node.name === command.nodeName,
  )
  const storedAttempt = snapshot?.attempts.find(
    (attempt) => attempt.id === command.attemptId,
  )

  if (!isFreshActivityAttempt(command, storedNode, storedAttempt)) {
    await reconcileStaleAttempt(input, command, storedNode, storedAttempt)
    return
  }

  if (snapshot?.run.workflowName !== command.workflowName) {
    await input.attemptExecutor.release(input.claimed)
    return
  }

  const registry = createWorkflowRuntimeRegistry({
    workflows: input.workflows as readonly WorkflowImplementation[],
  })
  const workflow = registry.getWorkflow(command.workflowName)
  if (!workflow) {
    await input.attemptExecutor.release(input.claimed)
    return
  }

  const node = resolveActivityAttemptNode(
    workflow,
    storedNode,
    storedAttempt,
    command,
  )
  if (!node) {
    await input.attemptExecutor.release(input.claimed)
    return
  }

  let output: unknown
  try {
    const ctx = await input.container.createContext(node.activity.dependencies)
    output = await node.activity.handler(
      ctx as DependencyContext<any>,
      command.input,
    )
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
      if (snapshot?.run.kind === 'task') {
        const failed = await input.store.failRun({
          runId: command.runId,
          error,
        })
        await wakeParentRun({
          store: input.store,
          runCoordinationExecutor: input.runCoordinationExecutor,
          run: failed,
        })
        await input.attemptExecutor.ack(input.claimed)
        return
      }
      await enqueueContinueRun(input.runCoordinationExecutor, command)
    }

    await input.attemptExecutor.ack(input.claimed)
    return
  }

  const attempt = await input.store.completeCurrentAttempt({
    attemptId: command.attemptId,
    leaseToken: command.leaseToken,
    output,
  })
  if (!attempt) {
    await input.attemptExecutor.ack(input.claimed)
    return
  }

  if (shouldCompleteNodeFromAttempt(storedNode)) {
    await input.store.completeNode({
      runId: command.runId,
      nodeName: command.nodeName,
      output,
    })
  }
  await enqueueContinueRun(input.runCoordinationExecutor, command)
  await input.attemptExecutor.ack(input.claimed)
}

function resolveActivityAttemptNode(
  workflow: WorkflowImplementation,
  storedNode: StoredNode | undefined,
  storedAttempt: StoredAttempt | undefined,
  command: ActivityAttemptCommand,
): ActivityAttemptNode | undefined {
  const direct = workflow.nodes.find(
    (candidate): candidate is ActivityNodeImplementation =>
      candidate.kind === 'activity' && candidate.name === command.nodeName,
  )
  if (direct) {
    return direct.activity.name === command.activityName ? direct : undefined
  }

  if (!storedNode) {
    return undefined
  }

  let selected: WorkflowCaseImplementation | undefined
  if (storedNode.kind === 'branch' && storedNode.selectedCase !== undefined) {
    const branch = workflow.nodes.find(
      (candidate): candidate is BranchNodeImplementation =>
        candidate.kind === 'branch' && candidate.name === command.nodeName,
    )
    selected = branch?.cases[storedNode.selectedCase]
  }

  if (storedNode.kind === 'parallel') {
    const parallel = workflow.nodes.find(
      (candidate): candidate is ParallelNodeImplementation =>
        candidate.kind === 'parallel' && candidate.name === command.nodeName,
    )
    const memberKey = storedAttempt?.identity?.memberKey
    selected = memberKey === undefined ? undefined : parallel?.cases[memberKey]
  }

  if (selected?.kind !== 'activity') return undefined

  return selected.activity.name === command.activityName ? selected : undefined
}

export async function runTaskAttempt(
  input: RunTaskAttemptInput,
): Promise<void> {
  const command = input.claimed.command
  if (command.kind !== 'taskAttempt') {
    throw new Error(`Unsupported attempt command kind [${command.kind}]`)
  }

  const snapshot = await input.store.loadRunSnapshot(command.runId)
  const storedNode = snapshot?.nodes.find(
    (node) => node.name === command.nodeName,
  )
  const storedAttempt = snapshot?.attempts.find(
    (attempt) => attempt.id === command.attemptId,
  )

  if (!isFreshTaskAttempt(command, storedNode, storedAttempt)) {
    await reconcileStaleAttempt(input, command, storedNode, storedAttempt)
    return
  }

  if (snapshot?.run.workflowName !== command.workflowName) {
    await input.attemptExecutor.release(input.claimed)
    return
  }

  const registry = createWorkflowRuntimeRegistry({
    tasks: input.tasks,
  })
  const task = registry.getTask(command.taskName)
  if (!task) {
    await input.attemptExecutor.release(input.claimed)
    return
  }

  let output: unknown
  try {
    const ctx = await input.container.createContext(task.dependencies)
    output = await task.handler(ctx as DependencyContext<any>, command.input)
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
      await enqueueContinueRun(input.runCoordinationExecutor, command)
    }

    await input.attemptExecutor.ack(input.claimed)
    return
  }

  const attempt = await input.store.completeCurrentAttempt({
    attemptId: command.attemptId,
    leaseToken: command.leaseToken,
    output,
  })
  if (!attempt) {
    await input.attemptExecutor.ack(input.claimed)
    return
  }

  if (snapshot?.run.kind === 'task') {
    await input.store.completeNode({
      runId: command.runId,
      nodeName: command.nodeName,
      output,
    })
    const completed = await input.store.completeRun({
      runId: command.runId,
      output,
    })
    await wakeParentRun({
      store: input.store,
      runCoordinationExecutor: input.runCoordinationExecutor,
      run: completed,
    })
    await input.attemptExecutor.ack(input.claimed)
    return
  }

  if (shouldCompleteNodeFromAttempt(storedNode)) {
    await input.store.completeNode({
      runId: command.runId,
      nodeName: command.nodeName,
      output,
    })
  }
  await enqueueContinueRun(input.runCoordinationExecutor, command)
  await input.attemptExecutor.ack(input.claimed)
}

function isFreshActivityAttempt(
  command: ActivityAttemptCommand,
  storedNode: StoredNode | undefined,
  storedAttempt: StoredAttempt | undefined,
): boolean {
  return (
    storedNode !== undefined &&
    isCurrentAttemptForNode(storedNode, command.attemptId) &&
    storedAttempt !== undefined &&
    storedAttempt.status === 'started' &&
    storedAttempt.leaseToken === command.leaseToken
  )
}

function isFreshTaskAttempt(
  command: TaskAttemptCommand,
  storedNode: StoredNode | undefined,
  storedAttempt: StoredAttempt | undefined,
): boolean {
  return (
    storedNode !== undefined &&
    isCurrentAttemptForNode(storedNode, command.attemptId) &&
    storedAttempt !== undefined &&
    storedAttempt.status === 'started' &&
    storedAttempt.leaseToken === command.leaseToken
  )
}

type EnqueueContinueRunCommand = ActivityAttemptCommand | TaskAttemptCommand
type RunAttemptInput = RunActivityAttemptInput | RunTaskAttemptInput

async function reconcileStaleAttempt(
  input: RunAttemptInput,
  command: EnqueueContinueRunCommand,
  storedNode: StoredNode | undefined,
  storedAttempt: StoredAttempt | undefined,
): Promise<void> {
  const isCurrentAttempt = isCurrentAttemptForNode(
    storedNode,
    command.attemptId,
  )

  if (
    storedNode &&
    isCurrentAttempt &&
    storedAttempt?.status === 'completed' &&
    storedNode.status !== 'completed'
  ) {
    if (storedAttempt.runId === command.runId) {
      const snapshot = await input.store.loadRunSnapshot(command.runId)
      if (snapshot?.run.kind === 'task') {
        await input.store.completeNode({
          runId: command.runId,
          nodeName: command.nodeName,
          output: storedAttempt.output,
        })
        const completed = await input.store.completeRun({
          runId: command.runId,
          output: storedAttempt.output,
        })
        await wakeParentRun({
          store: input.store,
          runCoordinationExecutor: input.runCoordinationExecutor,
          run: completed,
        })
        await input.attemptExecutor.ack(input.claimed)
        return
      }
    }

    if (!shouldCompleteNodeFromAttempt(storedNode)) {
      await input.attemptExecutor.ack(input.claimed)
      return
    }

    await input.store.completeNode({
      runId: command.runId,
      nodeName: command.nodeName,
      output: storedAttempt.output,
    })
    await enqueueContinueRun(input.runCoordinationExecutor, command)
    await input.attemptExecutor.ack(input.claimed)
    return
  }

  if (
    storedNode &&
    isCurrentAttempt &&
    storedAttempt?.status === 'failed' &&
    storedNode.status !== 'failed'
  ) {
    const snapshot = await input.store.loadRunSnapshot(command.runId)
    if (snapshot?.run.kind === 'task') {
      await input.store.failNode({
        runId: command.runId,
        nodeName: command.nodeName,
        error:
          storedAttempt.error ??
          new Error(`Workflow attempt [${command.attemptId}] failed`),
      })
      const failed = await input.store.failRun({
        runId: command.runId,
        error:
          storedAttempt.error ??
          new Error(`Workflow attempt [${command.attemptId}] failed`),
      })
      await wakeParentRun({
        store: input.store,
        runCoordinationExecutor: input.runCoordinationExecutor,
        run: failed,
      })
      await input.attemptExecutor.ack(input.claimed)
      return
    }

    await input.store.failNode({
      runId: command.runId,
      nodeName: command.nodeName,
      error:
        storedAttempt.error ??
        new Error(`Workflow attempt [${command.attemptId}] failed`),
    })
    await enqueueContinueRun(input.runCoordinationExecutor, command)
    await input.attemptExecutor.ack(input.claimed)
    return
  }

  if (
    storedNode &&
    storedAttempt &&
    ((storedAttempt.status === 'completed' &&
      storedNode.status === 'completed') ||
      (storedAttempt.status === 'failed' && storedNode.status === 'failed'))
  ) {
    await enqueueContinueRun(input.runCoordinationExecutor, command)
  }

  await input.attemptExecutor.ack(input.claimed)
}

async function wakeParentRun(input: {
  readonly store: WorkflowStore
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly run:
    | {
        readonly parentRunId?: string
        readonly parentNodeName?: string
      }
    | undefined
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

function shouldCompleteNodeFromAttempt(storedNode: StoredNode | undefined) {
  return storedNode?.kind !== 'parallel'
}

function isCurrentAttemptForNode(
  storedNode: StoredNode | undefined,
  attemptId: string,
) {
  if (!storedNode) return false
  if (storedNode.kind === 'parallel') return true
  return storedNode.currentAttemptId === attemptId
}

async function enqueueContinueRun(
  runCoordinationExecutor: RunCoordinationExecutor,
  command: EnqueueContinueRunCommand,
): Promise<void> {
  await runCoordinationExecutor.enqueue({
    kind: 'continueRun',
    runId: command.runId,
    workflowName: command.workflowName,
  })
}
