import type { Container, DependencyContext } from '@nmtjs/core'

import type {
  ActivityNodeImplementation,
  RunnableNodeImplementation,
  TaskImplementation,
  WorkflowImplementation,
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
  readonly workflows: readonly WorkflowImplementation<any, any>[]
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

  const registry = createWorkflowRuntimeRegistry({
    workflows: input.workflows as readonly WorkflowImplementation[],
  })
  const workflow = registry.getWorkflow(command.workflowName)
  if (!workflow) {
    await failActivityAttemptConfiguration(
      input,
      new Error(
        `No workflow implementation registered for [${command.workflowName}]`,
      ),
    )
    return
  }

  const node = workflow.nodes.find(
    (candidate): candidate is ActivityNodeImplementation =>
      candidate.kind === 'activity' && candidate.name === command.nodeName,
  )
  if (!node) {
    await failActivityAttemptConfiguration(
      input,
      new Error(
        `No activity implementation registered for [${command.workflowName}.${command.nodeName}]`,
      ),
    )
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

  await input.store.completeNode({
    runId: command.runId,
    nodeName: command.nodeName,
    output,
  })
  await enqueueContinueRun(input.runCoordinationExecutor, command)
  await input.attemptExecutor.ack(input.claimed)
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

  const registry = createWorkflowRuntimeRegistry({
    workflows: input.workflows as readonly WorkflowImplementation[],
    tasks: input.tasks,
  })
  const workflow = registry.getWorkflow(command.workflowName)
  if (!workflow) {
    await failTaskAttemptConfiguration(
      input,
      new Error(
        `No workflow implementation registered for [${command.workflowName}]`,
      ),
    )
    return
  }

  const node = workflow.nodes.find(
    (candidate): candidate is RunnableNodeImplementation =>
      candidate.kind === 'task' && candidate.name === command.nodeName,
  )
  if (!node || node.target.name !== command.taskName) {
    await failTaskAttemptConfiguration(
      input,
      new Error(
        `No task node implementation registered for [${command.workflowName}.${command.nodeName}.${command.taskName}]`,
      ),
    )
    return
  }

  const task = registry.getTask(command.taskName)
  if (task?.task !== node.target) {
    await failTaskAttemptConfiguration(
      input,
      new Error(`No task implementation registered for [${command.taskName}]`),
    )
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

  await input.store.completeNode({
    runId: command.runId,
    nodeName: command.nodeName,
    output,
  })
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
    storedNode.currentAttemptId === command.attemptId &&
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
    storedNode.currentAttemptId === command.attemptId &&
    storedAttempt !== undefined &&
    storedAttempt.status === 'started' &&
    storedAttempt.leaseToken === command.leaseToken
  )
}

async function failActivityAttemptConfiguration(
  input: RunActivityAttemptInput,
  error: Error,
): Promise<void> {
  const command = input.claimed.command
  if (command.kind !== 'activityAttempt') {
    throw new Error(`Unsupported attempt command kind [${command.kind}]`)
  }

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
}

async function failTaskAttemptConfiguration(
  input: RunTaskAttemptInput,
  error: Error,
): Promise<void> {
  const command = input.claimed.command
  if (command.kind !== 'taskAttempt') {
    throw new Error(`Unsupported attempt command kind [${command.kind}]`)
  }

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
}

type EnqueueContinueRunCommand = ActivityAttemptCommand | TaskAttemptCommand
type RunAttemptInput = RunActivityAttemptInput | RunTaskAttemptInput

async function reconcileStaleAttempt(
  input: RunAttemptInput,
  command: EnqueueContinueRunCommand,
  storedNode: StoredNode | undefined,
  storedAttempt: StoredAttempt | undefined,
): Promise<void> {
  if (
    storedNode &&
    storedAttempt?.status === 'completed' &&
    storedNode.status !== 'completed'
  ) {
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
    storedAttempt?.status === 'failed' &&
    storedNode.status !== 'failed'
  ) {
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
