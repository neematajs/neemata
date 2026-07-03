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
  AnyTaskDefinition,
  AnyWorkflowDefinition,
  BranchCaseDefinition,
  DurationString,
  RetryPolicy,
  Schema,
} from '../types/index.ts'
import type {
  ActivityAttemptCommand,
  ClaimedAttempt,
  TaskAttemptCommand,
} from './commands.ts'
import type { AttemptExecutor, RunCoordinationExecutor } from './executors.ts'
import type { StoredAttempt, StoredNode } from './state.ts'
import type {
  PruneTerminalRunsParams,
  WorkflowRetentionPruner,
  WorkflowStore,
} from './store.ts'
import { continueWorkflowRun } from './coordinator.ts'
import { parseDurationMs } from './duration.ts'
import { createWorkflowRuntimeRegistry } from './registry.ts'
import { isTerminalRunStatus } from './status.ts'
import { wakeParentRun } from './wake.ts'

type ActivityAttemptNode =
  | ActivityNodeImplementation
  | Extract<WorkflowCaseImplementation, { readonly kind: 'activity' }>

type AnyWorkflowImplementation = WorkflowImplementation<
  AnyWorkflowDefinition,
  any
>
type AnyTaskImplementation = TaskImplementation<AnyTaskDefinition, any>

export class WorkflowAttemptTimeoutError extends Error {
  readonly runId: string
  readonly nodeName: string
  readonly attemptId: string
  readonly timeoutMs: number

  constructor(input: {
    readonly runId: string
    readonly nodeName: string
    readonly attemptId: string
    readonly timeoutMs: number
  }) {
    super(
      `Workflow attempt [${input.attemptId}] for [${input.runId}.${input.nodeName}] timed out after ${input.timeoutMs}ms`,
    )
    this.name = 'WorkflowAttemptTimeoutError'
    this.runId = input.runId
    this.nodeName = input.nodeName
    this.attemptId = input.attemptId
    this.timeoutMs = input.timeoutMs
  }
}

export async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  assertPositiveInteger(concurrency, 'Concurrency')

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

export type WorkerLoopResult = {
  readonly processed: number
}

export type WorkerCommandResult = {
  readonly status: 'processed' | 'released'
}

export type WorkerRetentionOptions = {
  readonly olderThan: DurationString
  readonly everyMs?: number
  readonly batchSize?: number
  readonly statuses?: PruneTerminalRunsParams['statuses']
}

export type WorkerLoopOptions = {
  readonly workerId: string
  readonly concurrency?: number
  readonly leaseMs?: number
  readonly maxIdleClaims?: number
  readonly idleDelayMs?: number
  readonly retention?: WorkerRetentionOptions
  readonly retentionPruner?: WorkflowRetentionPruner
  readonly signal?: AbortSignal
}

export type RunWorkflowWorkerInput = WorkerLoopOptions & {
  readonly store: WorkflowStore
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly attemptExecutor: AttemptExecutor
  readonly atomicContinuation?: WorkflowRuntimeAtomicContinuation
  readonly workflows: readonly AnyWorkflowImplementation[]
  readonly container: Pick<Container, 'createContext'>
}

export type RunActivityWorkerInput = WorkerLoopOptions & {
  readonly store: WorkflowStore
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly attemptExecutor: AttemptExecutor
  readonly atomicCompletion?: WorkflowRuntimeAtomicCompletion
  readonly workflows: readonly AnyWorkflowImplementation[]
  readonly activityNames?: readonly string[]
  readonly container: Pick<Container, 'createContext'>
}

export type RunTaskWorkerInput = WorkerLoopOptions & {
  readonly store: WorkflowStore
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly attemptExecutor: AttemptExecutor
  readonly atomicCompletion?: WorkflowRuntimeAtomicCompletion
  readonly tasks: readonly AnyTaskImplementation[]
  readonly container: Pick<Container, 'createContext'>
}

export type WorkflowRuntimeOperationContext = {
  readonly store: WorkflowStore
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly attemptExecutor: AttemptExecutor
}

export type WorkflowRuntimeAtomicCompletion = {
  readonly run: <T>(
    handler: (runtime: WorkflowRuntimeOperationContext) => Promise<T>,
  ) => Promise<T>
}

export type WorkflowRuntimeAtomicContinuation = {
  readonly run: <T>(
    handler: (runtime: WorkflowRuntimeOperationContext) => Promise<T>,
  ) => Promise<T>
}

export async function runWorkflowWorker(
  input: RunWorkflowWorkerInput,
): Promise<WorkerLoopResult> {
  const workflowNames = input.workflows.map(
    (implementation) => implementation.workflow.name,
  )

  return runWorkerLoop(withDefaultRetentionPruner(input), async () => {
    const claimed = await input.runCoordinationExecutor.claim({
      workerId: input.workerId,
      workflowNames,
      leaseMs: input.leaseMs ?? DEFAULT_LEASE_MS,
    })
    if (!claimed) return false

    try {
      return await runAtomicContinuation(input, async (scoped) => {
        const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS
        const result = await continueWorkflowRun({
          store: scoped.store,
          runCoordinationExecutor: scoped.runCoordinationExecutor,
          attemptExecutor: scoped.attemptExecutor,
          container: input.container,
          workflows: input.workflows,
          workerId: input.workerId,
          command: claimed.command,
          leaseMs,
        })
        if (result.status !== 'processed') {
          await scoped.runCoordinationExecutor.release(claimed)
          return false
        }

        await scoped.runCoordinationExecutor.ack(claimed)
        return true
      })
    } catch (error) {
      if (isStaleWorkflowCommandAck(error)) {
        await input.runCoordinationExecutor.release(claimed)
        return false
      }
      await input.runCoordinationExecutor.release(claimed, { error })
      throw error
    }
  })
}

export async function runActivityWorker(
  input: RunActivityWorkerInput,
): Promise<WorkerLoopResult> {
  const workflowNames = input.workflows.map(
    (implementation) => implementation.workflow.name,
  )
  const activityNames =
    input.activityNames ?? collectWorkflowActivityNames(input.workflows)

  return runWorkerLoop(withDefaultRetentionPruner(input), async () => {
    const claimed = await input.attemptExecutor.claimActivity({
      workerId: input.workerId,
      workflowNames,
      activityNames,
      leaseMs: input.leaseMs ?? DEFAULT_LEASE_MS,
    })
    if (!claimed) return false

    try {
      const result = await runActivityAttempt({ ...input, claimed })
      return result.status === 'processed'
    } catch (error) {
      if (
        isStaleWorkflowCommandAck(error) ||
        isAttemptHeartbeatLeaseLost(error)
      ) {
        await input.attemptExecutor.release(claimed)
        return false
      }
      await input.attemptExecutor.release(claimed, { error })
      throw error
    }
  })
}

export async function runTaskWorker(
  input: RunTaskWorkerInput,
): Promise<WorkerLoopResult> {
  const taskNames = input.tasks.map(
    (implementation) => implementation.task.name,
  )

  return runWorkerLoop(withDefaultRetentionPruner(input), async () => {
    const claimed = await input.attemptExecutor.claimTask({
      workerId: input.workerId,
      taskNames,
      leaseMs: input.leaseMs ?? DEFAULT_LEASE_MS,
    })
    if (!claimed) return false

    try {
      const result = await runTaskAttempt({ ...input, claimed })
      return result.status === 'processed'
    } catch (error) {
      if (
        isStaleWorkflowCommandAck(error) ||
        isAttemptHeartbeatLeaseLost(error)
      ) {
        await input.attemptExecutor.release(claimed)
        return false
      }
      await input.attemptExecutor.release(claimed, { error })
      throw error
    }
  })
}

export type RunActivityAttemptInput = {
  readonly store: WorkflowStore
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly attemptExecutor: AttemptExecutor
  readonly atomicCompletion?: WorkflowRuntimeAtomicCompletion
  readonly workflows: readonly AnyWorkflowImplementation[]
  readonly workerId: string
  readonly claimed: ClaimedAttempt
  readonly leaseMs?: number
  readonly container: Pick<Container, 'createContext'>
}

export type RunTaskAttemptInput = {
  readonly store: WorkflowStore
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly attemptExecutor: AttemptExecutor
  readonly atomicCompletion?: WorkflowRuntimeAtomicCompletion
  readonly tasks: readonly AnyTaskImplementation[]
  readonly workerId: string
  readonly claimed: ClaimedAttempt
  readonly leaseMs?: number
  readonly container: Pick<Container, 'createContext'>
}

const DEFAULT_LEASE_MS = 30_000

async function runWorkerLoop(
  options: WorkerLoopOptions,
  claimAndRun: () => Promise<boolean>,
): Promise<WorkerLoopResult> {
  const concurrency = options.concurrency ?? 1
  const maxIdleClaims = options.maxIdleClaims ?? 1
  assertPositiveInteger(concurrency, 'Concurrency')
  assertPositiveInteger(maxIdleClaims, 'Max idle claims')

  let processed = 0
  let firstError: unknown
  let stopped = false
  let lastRetentionAt = 0
  let retentionRunning = false
  const runRetentionPrune = async () => {
    if (!options.retention || !options.retentionPruner) return
    const everyMs = options.retention.everyMs ?? 60_000
    if (!Number.isFinite(everyMs) || everyMs < 0) {
      throw new Error('Retention everyMs must be a non-negative number')
    }
    const date = Date.now()
    if (retentionRunning || date - lastRetentionAt < everyMs) return

    const olderThanMs = parseDurationMs(options.retention.olderThan)
    if (olderThanMs === undefined) {
      throw new Error(
        `Invalid retention olderThan duration [${options.retention.olderThan}]`,
      )
    }

    retentionRunning = true
    lastRetentionAt = date
    try {
      await options.retentionPruner.pruneTerminalRuns({
        olderThan: new Date(date - olderThanMs),
        batchSize: options.retention.batchSize,
        statuses: options.retention.statuses,
      })
    } finally {
      retentionRunning = false
    }
  }
  await Promise.allSettled(
    Array.from({ length: concurrency }, async () => {
      let idleClaims = 0
      try {
        while (
          !stopped &&
          !options.signal?.aborted &&
          idleClaims < maxIdleClaims
        ) {
          const didWork = await claimAndRun()
          if (didWork) {
            processed += 1
            idleClaims = 0
            continue
          }

          idleClaims += 1
          await runRetentionPrune()
          if (idleClaims < maxIdleClaims) {
            await sleep(options.idleDelayMs ?? 0, options.signal)
          }
        }
      } catch (error) {
        stopped = true
        firstError ??= error
      }
    }),
  )

  if (firstError) throw firstError
  return { processed }
}

function withDefaultRetentionPruner<
  Input extends WorkerLoopOptions & { readonly store: WorkflowStore },
>(input: Input): Input {
  if (input.retentionPruner) return input
  return { ...input, retentionPruner: input.store }
}

async function sleep(
  ms: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (ms <= 0 || signal?.aborted) return

  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', done)
      resolve()
    }

    const timeout = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`)
  }
}

function isStaleWorkflowCommandAck(error: unknown): boolean {
  return (
    error instanceof Error && error.message === 'Stale workflow command ack'
  )
}

function isAttemptHeartbeatLeaseLost(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message === 'Workflow attempt heartbeat lease lost'
  )
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

function collectWorkflowActivityNames(
  workflows: readonly AnyWorkflowImplementation[],
): readonly string[] {
  const names = new Set<string>()
  for (const workflow of workflows) {
    for (const node of workflow.nodes) {
      if (node.kind === 'activity') {
        names.add(node.activity.name)
        continue
      }

      if (node.kind === 'branch' || node.kind === 'parallel') {
        for (const member of Object.values(node.cases)) {
          if (member.kind === 'activity') names.add(member.activity.name)
        }
      }
    }
  }

  return [...names]
}

async function runAtomicCompletion<Input extends RunAttemptInput, Result>(
  input: Input,
  handler: (scopedInput: Input) => Promise<Result>,
): Promise<Result> {
  if (!input.atomicCompletion) return await handler(input)

  return await input.atomicCompletion.run((runtime) =>
    handler({
      ...input,
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
    }),
  )
}

async function runAtomicContinuation<Result>(
  input: RunWorkflowWorkerInput,
  handler: (runtime: WorkflowRuntimeOperationContext) => Promise<Result>,
): Promise<Result> {
  if (!input.atomicContinuation) {
    return await handler({
      store: input.store,
      runCoordinationExecutor: input.runCoordinationExecutor,
      attemptExecutor: input.attemptExecutor,
    })
  }

  return await input.atomicContinuation.run(handler)
}

async function runWithAttemptHeartbeat<T>(
  input: Pick<RunAttemptInput, 'attemptExecutor' | 'claimed' | 'leaseMs'>,
  handler: () => Promise<T>,
  timeout?: {
    readonly timeoutMs: number
    readonly createError: () => Error
  },
): Promise<T> {
  const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS
  const intervalMs = Math.max(1, Math.floor(leaseMs / 3))
  let heartbeatRunning = false
  let heartbeatFailed = false
  let rejectHeartbeat: (error: unknown) => void = () => {}
  const heartbeatFailure = new Promise<never>((_resolve, reject) => {
    rejectHeartbeat = reject
  })
  const interval = setInterval(() => {
    if (heartbeatRunning || heartbeatFailed) return
    heartbeatRunning = true
    void input.attemptExecutor
      .heartbeat(input.claimed, leaseMs)
      .catch((error: unknown) => {
        if (!isAttemptHeartbeatLeaseLost(error)) return
        heartbeatFailed = true
        rejectHeartbeat(error)
      })
      .finally(() => {
        heartbeatRunning = false
      })
  }, intervalMs)
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const timeoutFailure =
    timeout === undefined
      ? undefined
      : new Promise<never>((_resolve, reject) => {
          timeoutHandle = setTimeout(
            () => reject(timeout.createError()),
            timeout.timeoutMs,
          )
        })

  try {
    const work = handler()
    work.catch(() => {})
    return await Promise.race(
      timeoutFailure === undefined
        ? [work, heartbeatFailure]
        : [work, heartbeatFailure, timeoutFailure],
    )
  } finally {
    clearInterval(interval)
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
  }
}

export async function runActivityAttempt(
  input: RunActivityAttemptInput,
): Promise<WorkerCommandResult> {
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
  if (snapshot && isTerminalRunStatus(snapshot.run.status)) {
    return await ackTerminalAttempt(input)
  }

  if (!isFreshAttempt(command, storedNode, storedAttempt)) {
    return await runAtomicCompletion(input, (scoped) =>
      reconcileStaleAttempt(scoped, command, storedNode, storedAttempt),
    )
  }

  if (snapshot?.run.workflowName !== command.workflowName) {
    await input.attemptExecutor.release(input.claimed)
    return { status: 'released' }
  }

  const registry = createWorkflowRuntimeRegistry({
    workflows: input.workflows,
  })
  const workflow = registry.getWorkflow(command.workflowName) as
    | WorkflowImplementation
    | undefined
  if (!workflow) {
    await input.attemptExecutor.release(input.claimed)
    return { status: 'released' }
  }

  const node = resolveActivityAttemptNode(
    workflow,
    storedNode,
    storedAttempt,
    command,
  )
  if (!node) {
    await input.attemptExecutor.release(input.claimed)
    return { status: 'released' }
  }

  let output: unknown
  try {
    const timeoutMs = resolveActivityAttemptTimeoutMs(
      workflow,
      storedNode,
      storedAttempt,
      command,
    )
    output = await runWithAttemptHeartbeat(
      input,
      async () => {
        const ctx = await input.container.createContext(
          node.activity.dependencies,
        )
        return await node.activity.handler(
          ctx as DependencyContext<any>,
          command.input,
        )
      },
      timeoutMs === undefined
        ? undefined
        : {
            timeoutMs,
            createError: () =>
              new WorkflowAttemptTimeoutError({
                runId: command.runId,
                nodeName: command.nodeName,
                attemptId: command.attemptId,
                timeoutMs,
              }),
          },
    )
    const outputSchema = resolveActivityAttemptOutputSchema(
      workflow,
      storedNode,
      storedAttempt,
      command,
    )
    if (outputSchema) {
      output = decodeSchemaValue(
        outputSchema.schema,
        output,
        outputSchema.label,
      )
    }
  } catch (error) {
    if (isAttemptHeartbeatLeaseLost(error)) throw error
    return await runAtomicCompletion(input, async (scoped) => {
      const attempt = await scoped.store.failCurrentAttempt({
        attemptId: command.attemptId,
        leaseToken: command.leaseToken,
        error,
      })

      if (attempt) {
        const retried = await retryActivityAttempt(scoped, {
          command,
          failedAttempt: attempt,
          retry: node.retry,
        })
        if (retried) {
          await scoped.attemptExecutor.ack(scoped.claimed)
          return { status: 'processed' }
        }

        await scoped.store.failNode({
          runId: command.runId,
          nodeName: command.nodeName,
          error,
        })
        if (snapshot?.run.kind === 'task') {
          const failed = await scoped.store.failRun({
            runId: command.runId,
            error,
          })
          await wakeParentRun({
            store: scoped.store,
            runCoordinationExecutor: scoped.runCoordinationExecutor,
            run: failed,
          })
          await scoped.attemptExecutor.ack(scoped.claimed)
          return { status: 'processed' }
        }
        await enqueueContinueRun(scoped.runCoordinationExecutor, command)
      }

      await scoped.attemptExecutor.ack(scoped.claimed)
      return { status: 'processed' }
    })
  }

  return await runAtomicCompletion(input, async (scoped) => {
    const attempt = await scoped.store.completeCurrentAttempt({
      attemptId: command.attemptId,
      leaseToken: command.leaseToken,
      output,
    })
    if (!attempt) {
      await scoped.attemptExecutor.ack(scoped.claimed)
      return { status: 'processed' }
    }

    if (shouldCompleteNodeFromAttempt(storedNode)) {
      await scoped.store.completeNode({
        runId: command.runId,
        nodeName: command.nodeName,
        output,
      })
    }
    await enqueueContinueRun(scoped.runCoordinationExecutor, command)
    await scoped.attemptExecutor.ack(scoped.claimed)
    return { status: 'processed' }
  })
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

function resolveActivityAttemptTimeoutMs(
  workflow: WorkflowImplementation,
  storedNode: StoredNode | undefined,
  storedAttempt: StoredAttempt | undefined,
  command: ActivityAttemptCommand,
): number | undefined {
  const declaration = workflow.workflow.nodes.find(
    (candidate) => candidate.name === command.nodeName,
  )
  if (!declaration) return undefined
  if (declaration.kind === 'activity')
    return parseDurationMs(declaration.timeout)
  if (declaration.kind === 'branch') {
    const caseKey = storedAttempt?.identity?.caseKey ?? storedNode?.selectedCase
    const selected =
      caseKey === undefined ? undefined : declaration.cases[caseKey]
    if (selected?.kind !== 'activity') return undefined
    const activityDeclaration = selected as BranchCaseDefinition<'activity'>
    return parseDurationMs(activityDeclaration.timeout)
  }
  if (declaration.kind === 'parallel') {
    const memberKey = storedAttempt?.identity?.memberKey
    const selected =
      memberKey === undefined ? undefined : declaration.cases[memberKey]
    if (selected?.kind !== 'activity') return undefined
    const activityDeclaration = selected as BranchCaseDefinition<'activity'>
    return parseDurationMs(activityDeclaration.timeout)
  }
  return undefined
}

function resolveActivityAttemptOutputSchema(
  workflow: WorkflowImplementation,
  storedNode: StoredNode | undefined,
  storedAttempt: StoredAttempt | undefined,
  command: ActivityAttemptCommand,
): { readonly schema: Schema; readonly label: string } | undefined {
  const declaration = workflow.workflow.nodes.find(
    (candidate) => candidate.name === command.nodeName,
  )
  if (!declaration) return undefined
  if (declaration.kind === 'activity') {
    return {
      schema: declaration.output,
      label: `activity output [${workflow.workflow.name}.${command.nodeName}]`,
    }
  }
  if (declaration.kind === 'branch') {
    const caseKey = storedAttempt?.identity?.caseKey ?? storedNode?.selectedCase
    const selected =
      caseKey === undefined ? undefined : declaration.cases[caseKey]
    if (selected?.kind !== 'activity') return undefined
    const activityDeclaration = selected as BranchCaseDefinition<'activity'>
    return {
      schema: activityDeclaration.output,
      label: `activity output [${workflow.workflow.name}.${command.nodeName}.${caseKey}]`,
    }
  }
  if (declaration.kind === 'parallel') {
    const memberKey = storedAttempt?.identity?.memberKey
    const selected =
      memberKey === undefined ? undefined : declaration.cases[memberKey]
    if (selected?.kind !== 'activity') return undefined
    const activityDeclaration = selected as BranchCaseDefinition<'activity'>
    return {
      schema: activityDeclaration.output,
      label: `activity output [${workflow.workflow.name}.${command.nodeName}.${memberKey}]`,
    }
  }
  return undefined
}

export async function runTaskAttempt(
  input: RunTaskAttemptInput,
): Promise<WorkerCommandResult> {
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
  if (snapshot && isTerminalRunStatus(snapshot.run.status)) {
    return await ackTerminalAttempt(input)
  }

  if (!isFreshAttempt(command, storedNode, storedAttempt)) {
    return await runAtomicCompletion(input, (scoped) =>
      reconcileStaleAttempt(scoped, command, storedNode, storedAttempt),
    )
  }

  if (snapshot?.run.workflowName !== command.workflowName) {
    await input.attemptExecutor.release(input.claimed)
    return { status: 'released' }
  }

  const registry = createWorkflowRuntimeRegistry({
    tasks: input.tasks,
  })
  const task = registry.getTask(command.taskName)
  if (!task) {
    await input.attemptExecutor.release(input.claimed)
    return { status: 'released' }
  }

  let output: unknown
  try {
    const timeoutMs = parseDurationMs(command.timeout ?? task.task.timeout)
    output = await runWithAttemptHeartbeat(
      input,
      async () => {
        const ctx = await input.container.createContext(task.dependencies)
        return await task.handler(ctx as DependencyContext<any>, command.input)
      },
      timeoutMs === undefined
        ? undefined
        : {
            timeoutMs,
            createError: () =>
              new WorkflowAttemptTimeoutError({
                runId: command.runId,
                nodeName: command.nodeName,
                attemptId: command.attemptId,
                timeoutMs,
              }),
          },
    )
    output = decodeSchemaValue(
      task.task.output,
      output,
      `task output [${task.task.name}]`,
    )
  } catch (error) {
    if (isAttemptHeartbeatLeaseLost(error)) throw error
    return await runAtomicCompletion(input, async (scoped) => {
      const attempt = await scoped.store.failCurrentAttempt({
        attemptId: command.attemptId,
        leaseToken: command.leaseToken,
        error,
      })

      if (attempt) {
        const retried = await retryTaskAttempt(scoped, {
          command,
          failedAttempt: attempt,
          retry: task.task.retry,
        })
        if (retried) {
          await scoped.attemptExecutor.ack(scoped.claimed)
          return { status: 'processed' }
        }

        await scoped.store.failNode({
          runId: command.runId,
          nodeName: command.nodeName,
          error,
        })
        if (snapshot?.run.kind === 'task') {
          const failed = await scoped.store.failRun({
            runId: command.runId,
            error,
          })
          await wakeParentRun({
            store: scoped.store,
            runCoordinationExecutor: scoped.runCoordinationExecutor,
            run: failed,
          })
          await scoped.attemptExecutor.ack(scoped.claimed)
          return { status: 'processed' }
        }
        await enqueueContinueRun(scoped.runCoordinationExecutor, command)
      }

      await scoped.attemptExecutor.ack(scoped.claimed)
      return { status: 'processed' }
    })
  }

  return await runAtomicCompletion(input, async (scoped) => {
    const attempt = await scoped.store.completeCurrentAttempt({
      attemptId: command.attemptId,
      leaseToken: command.leaseToken,
      output,
    })
    if (!attempt) {
      await scoped.attemptExecutor.ack(scoped.claimed)
      return { status: 'processed' }
    }

    if (snapshot?.run.kind === 'task') {
      await scoped.store.completeNode({
        runId: command.runId,
        nodeName: command.nodeName,
        output,
      })
      const completed = await scoped.store.completeRun({
        runId: command.runId,
        output,
      })
      await wakeParentRun({
        store: scoped.store,
        runCoordinationExecutor: scoped.runCoordinationExecutor,
        run: completed,
      })
      await scoped.attemptExecutor.ack(scoped.claimed)
      return { status: 'processed' }
    }

    if (shouldCompleteNodeFromAttempt(storedNode)) {
      await scoped.store.completeNode({
        runId: command.runId,
        nodeName: command.nodeName,
        output,
      })
    }
    await enqueueContinueRun(scoped.runCoordinationExecutor, command)
    await scoped.attemptExecutor.ack(scoped.claimed)
    return { status: 'processed' }
  })
}

function isFreshAttempt(
  command: Pick<
    ActivityAttemptCommand | TaskAttemptCommand,
    'attemptId' | 'leaseToken'
  >,
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

async function ackTerminalAttempt(
  input: RunAttemptInput,
): Promise<WorkerCommandResult> {
  return await runAtomicCompletion(input, async (scoped) => {
    await scoped.attemptExecutor.ack(scoped.claimed)
    return { status: 'processed' }
  })
}

async function retryActivityAttempt(
  input: RunActivityAttemptInput,
  params: {
    readonly command: ActivityAttemptCommand
    readonly failedAttempt: StoredAttempt
    readonly retry?: RetryPolicy
  },
): Promise<boolean> {
  return retryAttemptCore(input, params, async (retryAttempt, options) => {
    await input.attemptExecutor.dispatchActivity(
      {
        kind: 'activityAttempt',
        workflowName: params.command.workflowName,
        activityName: params.command.activityName,
        runId: params.command.runId,
        nodeName: params.command.nodeName,
        attemptId: retryAttempt.id,
        leaseToken: retryAttempt.leaseToken!,
        input: retryAttempt.input,
        ...(retryAttempt.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: retryAttempt.idempotencyKey }),
      },
      options,
    )
  })
}

async function retryTaskAttempt(
  input: RunTaskAttemptInput,
  params: {
    readonly command: TaskAttemptCommand
    readonly failedAttempt: StoredAttempt
    readonly retry?: RetryPolicy
  },
): Promise<boolean> {
  return retryAttemptCore(input, params, async (retryAttempt, options) => {
    await input.attemptExecutor.dispatchTask(
      {
        kind: 'taskAttempt',
        workflowName: params.command.workflowName,
        taskName: params.command.taskName,
        runId: params.command.runId,
        nodeName: params.command.nodeName,
        attemptId: retryAttempt.id,
        leaseToken: retryAttempt.leaseToken!,
        input: retryAttempt.input,
        ...(retryAttempt.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: retryAttempt.idempotencyKey }),
        ...(params.command.timeout === undefined
          ? {}
          : { timeout: params.command.timeout }),
      },
      options,
    )
  })
}

async function retryAttemptCore(
  input: RunAttemptInput,
  params: {
    readonly command: ActivityAttemptCommand | TaskAttemptCommand
    readonly failedAttempt: StoredAttempt
    readonly retry?: RetryPolicy
  },
  dispatch: (
    retryAttempt: StoredAttempt,
    options: { readonly runAt?: Date } | undefined,
  ) => Promise<void>,
): Promise<boolean> {
  if (!shouldRetryAttempt(params.failedAttempt, params.retry)) return false

  const retryAttempt = await input.store.createAttempt({
    runId: params.command.runId,
    nodeName: params.command.nodeName,
    input: params.failedAttempt.input,
    idempotencyKey: params.failedAttempt.idempotencyKey,
  })
  await dispatch(
    retryAttempt,
    retryDispatchOptions(params.retry, params.failedAttempt.attemptNumber),
  )
  return true
}

function shouldRetryAttempt(
  failedAttempt: StoredAttempt,
  retry: RetryPolicy | undefined,
): retry is RetryPolicy {
  return retry !== undefined && failedAttempt.attemptNumber < retry.attempts
}

function retryDispatchOptions(
  retry: RetryPolicy | undefined,
  failedAttemptNumber: number,
): { readonly runAt?: Date } | undefined {
  const delayMs = retryDelayMs(retry, failedAttemptNumber)
  return delayMs > 0 ? { runAt: new Date(Date.now() + delayMs) } : undefined
}

function retryDelayMs(
  retry: RetryPolicy | undefined,
  failedAttemptNumber: number,
): number {
  const base = parseDurationMs(retry?.delay) ?? 0
  if (base === 0) return 0
  return retry?.backoff === 'exponential'
    ? base * 2 ** Math.max(0, failedAttemptNumber - 1)
    : base
}

async function reconcileStaleAttempt(
  input: RunAttemptInput,
  command: EnqueueContinueRunCommand,
  storedNode: StoredNode | undefined,
  storedAttempt: StoredAttempt | undefined,
): Promise<WorkerCommandResult> {
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
        return { status: 'processed' }
      }
    }

    if (!shouldCompleteNodeFromAttempt(storedNode)) {
      await enqueueContinueRun(input.runCoordinationExecutor, command)
      await input.attemptExecutor.ack(input.claimed)
      return { status: 'processed' }
    }

    await input.store.completeNode({
      runId: command.runId,
      nodeName: command.nodeName,
      output: storedAttempt.output,
    })
    await enqueueContinueRun(input.runCoordinationExecutor, command)
    await input.attemptExecutor.ack(input.claimed)
    return { status: 'processed' }
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
      return { status: 'processed' }
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
    return { status: 'processed' }
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
  return { status: 'processed' }
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
