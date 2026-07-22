import type {
  TaskImplementation,
  WorkflowImplementation,
} from '../implement/index.ts'
import type {
  AnyTaskDefinition,
  AnyWorkflowDefinition,
  RunUniqueConstraint,
  TaskInput,
  TaskRun,
  WorkflowInput,
  WorkflowRun,
} from '../types/index.ts'
import type { WorkflowRuntimeAtomicStart } from './coordinator.ts'
import type { AttemptExecutor, RunCoordinationExecutor } from './executors.ts'
import type { WorkflowScheduler } from './scheduler.ts'
import type { RunSnapshot, StoredError, StoredRun } from './state.ts'
import type {
  DeadWorkflowCommand,
  DeleteRunResult,
  ListRunsFilter,
  ListRunSummariesResult,
  ListRunsResult,
  NodeSnapshot,
  PruneTerminalRunsParams,
  PruneTerminalRunsResult,
  RunDetail,
  RunFamilyEntry,
  WorkflowRetentionPruner,
  WorkflowStore,
} from './store.ts'
import type { WorkflowWakeEvents } from './wake-events.ts'
import type {
  WorkflowRuntimeAtomicCompletion,
  WorkflowRuntimeAtomicContinuation,
} from './worker.ts'
import { startTaskRun, startWorkflowRun } from './coordinator.ts'
import {
  createWorkflowRuntimeRegistry,
  type RegisteredTaskImplementation,
  type RegisteredWorkflowImplementation,
  type WorkflowRuntimeRegistry,
} from './registry.ts'
import { isTerminalRunStatus } from './status.ts'

export type WorkflowRuntimeStartOptions<Connection = never> = {
  readonly tags?: Readonly<Record<string, string>>
  readonly idempotencyKey?: readonly unknown[]
  /**
   * Overrides the definition-level `unique` builder. See RunUniqueConstraint;
   * `retry()` re-applies the stored run's constraint unless overridden here.
   */
  readonly unique?: RunUniqueConstraint
  readonly startAt?: Date
  /**
   * Adapter connection already inside the caller's open transaction (the one
   * handed to `transaction()`'s handler, or built over an external client
   * whose own `transaction` nests) — run creation and dispatch then commit or
   * roll back with the caller's writes. The returned snapshot is provisional
   * until that commit. Never wrap a bare query client that is mid-transaction:
   * without a nesting-aware `transaction`, its COMMIT would end the caller's
   * transaction early. The in-memory runtime ignores this option so
   * postgres-facing code paths run against it unchanged.
   */
  readonly connection?: Connection
}

export type WatchRunOptions = {
  /**
   * Also yield a coarse `{ kind: 'change' }` event on every wake notification
   * for the watched run's family. Family-granular by construction: the notify
   * key is the root run id, and node-level transitions don't touch any row a
   * run-scoped watcher could re-read to self-filter. Coarse events have no
   * poll backstop — a missed notification is invisible until the next wake or
   * the terminal transition. Best-effort intermediates; terminal delivery
   * stays poll-guaranteed.
   */
  readonly wake?: boolean
  /**
   * Coalesce wake-driven yields: first wake after quiet passes immediately
   * (leading edge), further wakes inside the window collapse into one more
   * yield when it closes (trailing edge). Terminal discovery is never
   * suppressed. 0/absent = raw wakes.
   */
  readonly debounceMs?: number
  readonly signal?: AbortSignal
  readonly pollIntervalMs?: number
}

export type WatchEvent =
  | { readonly kind: 'change' }
  | {
      readonly kind: 'run'
      readonly status: StoredRun['status']
      readonly error?: StoredError
    }

export type WorkflowRuntimeAdapter<Connection = never> = {
  readonly store: WorkflowStore
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly attemptExecutor: AttemptExecutor
  readonly retentionPruner?: WorkflowRetentionPruner
  readonly scheduler?: WorkflowScheduler
  readonly wakeEvents?: WorkflowWakeEvents
  readonly atomicStart?: WorkflowRuntimeAtomicStart<Connection>
  readonly atomicContinuation?: WorkflowRuntimeAtomicContinuation
  readonly atomicCompletion?: WorkflowRuntimeAtomicCompletion
  readonly dispose?: () => Promise<void> | void
}

export type CreateWorkflowRuntimeClientInput<Connection = never> =
  WorkflowRuntimeAdapter<Connection> & {
    readonly workflows?: readonly RegisteredWorkflowImplementation[]
    readonly tasks?: readonly RegisteredTaskImplementation[]
  }

export type WorkflowRuntimeClient<Connection = never> = {
  readonly start: {
    <Workflow extends AnyWorkflowDefinition>(
      workflow: Workflow,
      input: WorkflowInput<Workflow>,
      options?: WorkflowRuntimeStartOptions<Connection>,
    ): Promise<WorkflowRun<Workflow>>
    <Task extends AnyTaskDefinition>(
      task: Task,
      input: TaskInput<Task>,
      options?: WorkflowRuntimeStartOptions<Connection>,
    ): Promise<TaskRun<Task>>
  }
  readonly cancel: (runId: string) => Promise<StoredRun | undefined>
  readonly deleteRun: (runId: string) => Promise<DeleteRunResult>
  readonly retry: (
    runId: string,
    options?: WorkflowRuntimeStartOptions<Connection>,
  ) => Promise<StoredRun>
  readonly get: (runId: string) => Promise<RunSnapshot | undefined>
  readonly list: (filter?: ListRunsFilter) => Promise<ListRunsResult>
  readonly listSummaries: (
    filter?: ListRunsFilter,
  ) => Promise<ListRunSummariesResult>
  readonly getDetail: (runId: string) => Promise<RunDetail | undefined>
  readonly getNode: (
    runId: string,
    nodeName: string,
  ) => Promise<NodeSnapshot | undefined>
  readonly getFamily: (runId: string) => Promise<readonly RunFamilyEntry[]>
  readonly watch: (
    runId: string,
    options?: WatchRunOptions,
  ) => AsyncIterable<WatchEvent>
  readonly pruneRuns: (
    params: PruneTerminalRunsParams,
  ) => Promise<PruneTerminalRunsResult>
  readonly listDeadCommands: (params?: {
    readonly runId?: string
  }) => Promise<readonly DeadWorkflowCommand[]>
  readonly requeueDeadCommand: (id: string) => Promise<void>
  readonly schedules: {
    readonly list: WorkflowScheduler['list']
    readonly trigger: WorkflowScheduler['trigger']
    readonly setEnabled: WorkflowScheduler['setEnabled']
  }
}

export function createWorkflowRuntimeClient<Connection = never>(
  input: CreateWorkflowRuntimeClientInput<Connection>,
): WorkflowRuntimeClient<Connection> {
  const registry = createWorkflowRuntimeRegistry({
    workflows: input.workflows,
    tasks: input.tasks,
  })

  const start = (async (
    runnable: AnyWorkflowDefinition | AnyTaskDefinition,
    runnableInput: unknown,
    options?: WorkflowRuntimeStartOptions<Connection>,
  ) => {
    switch (runnable.kind) {
      case 'workflow':
        return (await startWorkflowRun({
          store: input.store,
          runCoordinationExecutor: input.runCoordinationExecutor,
          atomicStart: input.atomicStart,
          workflow: runnable,
          implementation: getWorkflowImplementation(registry, runnable),
          input: runnableInput,
          tags: options?.tags,
          idempotencyKey: options?.idempotencyKey,
          unique: options?.unique,
          startAt: options?.startAt,
          connection: options?.connection,
        })) as WorkflowRun<typeof runnable>
      case 'task':
        return (await startTaskRun({
          store: input.store,
          runCoordinationExecutor: input.runCoordinationExecutor,
          attemptExecutor: input.attemptExecutor,
          atomicStart: input.atomicStart,
          task: runnable,
          implementation: getTaskImplementation(registry, runnable),
          input: runnableInput,
          tags: options?.tags,
          idempotencyKey: options?.idempotencyKey,
          unique: options?.unique,
          startAt: options?.startAt,
          connection: options?.connection,
        })) as TaskRun<typeof runnable>
    }
  }) as WorkflowRuntimeClient<Connection>['start']
  const requireScheduler = () => {
    if (!input.scheduler) {
      throw new Error('Workflow runtime adapter does not support schedules')
    }
    return input.scheduler
  }

  return Object.freeze({
    start,
    deleteRun: (runId) => input.store.deleteRun(runId),
    retry: (runId, options) =>
      retryRun(input.store, registry, start, runId, options),
    cancel: async (runId) => {
      const run = await input.store.requestRunCancellation({ runId })
      if (!run) return undefined
      if (isTerminalRunStatus(run.status)) return run
      await input.runCoordinationExecutor.enqueue({
        kind: 'continueRun',
        runId: run.id,
        workflowName: run.workflowName,
      })
      return run
    },
    get: (runId) => input.store.loadRunSnapshot(runId),
    list: (filter) => input.store.listRuns(filter),
    listSummaries: (filter) => input.store.listRunSummaries(filter),
    getDetail: (runId) => input.store.loadRunDetail(runId),
    getNode: (runId, nodeName) =>
      input.store.loadNodeSnapshot({ runId, nodeName }),
    getFamily: (runId) => input.store.listRunFamily(runId),
    watch: (runId, options) =>
      watchRun({
        store: input.store,
        wakeEvents: input.wakeEvents,
        runId,
        options,
      }),
    pruneRuns: (params) => pruneRuns(input.store, params),
    listDeadCommands: (params) => input.store.listDeadCommands(params),
    requeueDeadCommand: (id) => input.store.requeueDeadCommand(id),
    schedules: {
      list: async () => requireScheduler().list(),
      trigger: async (name) => requireScheduler().trigger(name),
      setEnabled: async (name, enabled) =>
        requireScheduler().setEnabled(name, enabled),
    },
  })
}

async function* watchRun(params: {
  readonly store: WorkflowStore
  readonly wakeEvents?: WorkflowWakeEvents
  readonly runId: string
  readonly options?: WatchRunOptions
}): AsyncIterable<WatchEvent> {
  const [run] = await params.store.loadRuns([params.runId])
  if (!run) return

  const signal = params.options?.signal
  const pollIntervalMs = normalizePollInterval(params.options?.pollIntervalMs)
  const debounceMs = normalizeDebounce(params.options?.debounceMs)
  const coarse = params.options?.wake === true

  // Wakes arriving while a read/yield is in flight are latched, never lost.
  let wakePending = false
  let resolveWait: (() => void) | undefined
  const removeWake = params.wakeEvents?.onRunEvent?.(run.rootRunId, () => {
    wakePending = true
    resolveWait?.()
  })

  let cleanupWait: (() => void) | undefined
  const cleanup = () => {
    cleanupWait?.()
    cleanupWait = undefined
    resolveWait = undefined
  }
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        cleanup()
        resolve()
      }
      const timer = setTimeout(finish, ms)
      const removeAbort =
        signal === undefined
          ? undefined
          : () => signal.removeEventListener('abort', finish)
      signal?.addEventListener('abort', finish, { once: true })
      resolveWait = finish
      cleanupWait = () => {
        clearTimeout(timer)
        removeAbort?.()
      }
    })

  // Returns true when a wake was consumed (vs. a poll tick or abort). The
  // debounce window is anchored at the last consumed wake: a wake outside the
  // window passes immediately (leading edge), wakes inside it collapse into
  // one consumption when the window closes (trailing edge). Every wake inside
  // the window still peeks at the run row so a status transition — terminal
  // above all — is consumed without delay: the window only coalesces coarse
  // change yields, whose downstream refetches are the load being capped. The
  // peek reads themselves are deliberately uncapped (one cheap PK read per
  // wake, bounded by the window) — capping them would trade terminal latency
  // for savings on the wrong side of the debounce.
  let lastStatus: string | undefined
  let lastWakeConsumedAt = 0
  const waitForChange = async (): Promise<boolean> => {
    if (!wakePending) await sleep(pollIntervalMs)
    if (signal?.aborted || !wakePending) return false
    while (!signal?.aborted) {
      const remaining = lastWakeConsumedAt + debounceMs - Date.now()
      if (remaining <= 0) break
      wakePending = false
      const [current] = await params.store.loadRuns([params.runId])
      if (!current || current.status !== lastStatus) break
      if (!wakePending) await sleep(remaining)
      if (!wakePending) break
    }
    wakePending = false
    lastWakeConsumedAt = Date.now()
    return !signal?.aborted
  }

  // The subscription is in place before this baseline read, so nothing
  // committed after the read can slip through unnoticed. Coarse events are
  // NOTIFY-only best-effort; run-status transitions (including terminal) are
  // additionally guaranteed by the poll backstop re-reading the run row.
  let woke = false
  try {
    while (!signal?.aborted) {
      const [current] = await params.store.loadRuns([params.runId])
      if (!current) return
      if (current.status !== lastStatus) {
        lastStatus = current.status
        yield {
          kind: 'run',
          status: current.status,
          ...(current.error === undefined ? {} : { error: current.error }),
        }
        if (isTerminalRunStatus(current.status)) return
      } else if (coarse && woke) {
        yield { kind: 'change' }
      }
      if (signal?.aborted) return
      woke = await waitForChange()
    }
  } finally {
    cleanup()
    removeWake?.()
  }
}

async function pruneRuns(
  store: WorkflowStore,
  params: PruneTerminalRunsParams,
): Promise<PruneTerminalRunsResult> {
  const batchSize = normalizePruneBatchSize(params.batchSize)
  if (batchSize < 1) return { deleted: 0 }
  let deleted = 0

  while (true) {
    const result = await store.pruneTerminalRuns({ ...params, batchSize })
    deleted += result.deleted
    if (result.deleted < batchSize) return { deleted }
  }
}

async function retryRun<Connection>(
  store: WorkflowStore,
  registry: WorkflowRuntimeRegistry,
  start: WorkflowRuntimeClient<Connection>['start'],
  runId: string,
  options?: WorkflowRuntimeStartOptions<Connection>,
): Promise<StoredRun> {
  const [run] = await store.loadRuns([runId])
  if (!run) throw new Error(`Run [${runId}] not found`)
  if (!isTerminalRunStatus(run.status)) {
    throw new Error(`Run [${runId}] is not terminal`)
  }
  if (run.parentRunId !== undefined) {
    throw new Error(`Run [${runId}] is not a root run`)
  }

  switch (run.kind) {
    case 'workflow': {
      const implementation = registry.getWorkflow(run.workflowName)
      if (!implementation) {
        throw new Error(
          `No registered workflow implementation [${run.workflowName}]`,
        )
      }
      return (await start(implementation.workflow, run.input as never, {
        tags: run.tags,
        // scope 'all' constraints conflict with the terminal run itself on
        // retry — surfaced honestly; override via options.unique if intended
        ...(run.unique === undefined ? {} : { unique: run.unique }),
        ...options,
      })) as StoredRun
    }
    case 'task': {
      const taskName = run.taskName ?? run.name
      const implementation = registry.getTask(taskName)
      if (!implementation) {
        throw new Error(`No registered task implementation [${taskName}]`)
      }
      return (await start(implementation.task, run.input as never, {
        tags: run.tags,
        ...(run.unique === undefined ? {} : { unique: run.unique }),
        ...options,
      })) as StoredRun
    }
  }
}

function normalizePruneBatchSize(batchSize: number | undefined): number {
  if (batchSize === undefined) return 100
  if (!Number.isInteger(batchSize) || batchSize < 1) return 0
  return batchSize
}

function normalizeDebounce(debounceMs: number | undefined): number {
  if (debounceMs === undefined) return 0
  return Number.isFinite(debounceMs) && debounceMs > 0 ? debounceMs : 0
}

function normalizePollInterval(intervalMs: number | undefined): number {
  if (intervalMs === undefined) return 1_000
  return Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 1_000
}

function getWorkflowImplementation<WorkflowDef extends AnyWorkflowDefinition>(
  registry: WorkflowRuntimeRegistry,
  workflow: WorkflowDef,
) {
  const implementation = registry.getWorkflow(workflow.name)
  if (!implementation) return undefined
  if (implementation.workflow !== workflow) {
    throw new Error(
      `Registered workflow implementation [${workflow.name}] does not match declaration`,
    )
  }

  return implementation as WorkflowImplementation<WorkflowDef, any>
}

function getTaskImplementation<TaskDef extends AnyTaskDefinition>(
  registry: WorkflowRuntimeRegistry,
  task: TaskDef,
) {
  const implementation = registry.getTask(task.name)
  if (!implementation) return undefined
  if (implementation.task !== task) {
    throw new Error(
      `Registered task implementation [${task.name}] does not match declaration`,
    )
  }

  return implementation as TaskImplementation<TaskDef, any>
}
