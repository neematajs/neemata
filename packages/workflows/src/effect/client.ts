import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Stream from 'effect/Stream'

import type {
  WatchEvent,
  WatchRunOptions,
  WorkflowRuntimeClient,
  WorkflowRuntimeStartOptions,
} from '../runtime/client.ts'
import type { StoredWorkflowSchedule } from '../runtime/scheduler.ts'
import type { RunSnapshot, StoredRun } from '../runtime/state.ts'
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
} from '../runtime/store.ts'
import type {
  AnyTaskDefinition,
  AnyWorkflowDefinition,
  RunnableRun,
  TaskInput,
  TaskRun,
  WorkflowInput,
  WorkflowRun,
} from '../types/index.ts'
import {
  WorkflowIdempotencyConflictError,
  WorkflowRunConflictError,
} from '../runtime/errors.ts'

/**
 * Start options without the Promise client's `connection`: joining an Effect
 * SQL transaction is `createEffectSqlWorkflowClient`'s job.
 */
export type WorkflowStartOptions = Omit<
  WorkflowRuntimeStartOptions,
  'connection'
>

/** The failures a start or restart reports instead of treating as defects. */
export type WorkflowStartError =
  | WorkflowRunConflictError
  | WorkflowIdempotencyConflictError

/** Interrupting the stream's consumer stops the watch instead of a signal. */
export type WorkflowWatchOptions = Omit<WatchRunOptions, 'signal'>

/**
 * The workflow runtime client for Effect code. Start conflicts fail with
 * tagged errors; every other rejection, such as a missing run or input that
 * does not match its schema, is a defect. Interrupting a call stops waiting for
 * it, but the operation itself still completes: the Promise client cannot
 * cancel one. Each Effect-returning call runs in a `WorkflowClient.<method>`
 * span; `watch` streams are not traced.
 */
export class WorkflowClient extends Context.Service<
  WorkflowClient,
  {
    readonly start: {
      <Workflow extends AnyWorkflowDefinition>(
        workflow: Workflow,
        input: WorkflowInput<Workflow>,
        options?: WorkflowStartOptions,
      ): Effect.Effect<WorkflowRun<Workflow>, WorkflowStartError>
      <Task extends AnyTaskDefinition>(
        task: Task,
        input: TaskInput<Task>,
        options?: WorkflowStartOptions,
      ): Effect.Effect<TaskRun<Task>, WorkflowStartError>
    }
    readonly cancel: (runId: string) => Effect.Effect<StoredRun | undefined>
    readonly deleteRun: (runId: string) => Effect.Effect<DeleteRunResult>
    readonly retry: (
      runId: string,
      options?: { readonly expectedVersion?: number },
    ) => Effect.Effect<StoredRun>
    readonly restart: (
      runId: string,
      options?: WorkflowStartOptions,
    ) => Effect.Effect<RunnableRun, WorkflowStartError>
    readonly get: (runId: string) => Effect.Effect<RunSnapshot | undefined>
    readonly list: (filter?: ListRunsFilter) => Effect.Effect<ListRunsResult>
    readonly listSummaries: (
      filter?: ListRunsFilter,
    ) => Effect.Effect<ListRunSummariesResult>
    readonly getDetail: (runId: string) => Effect.Effect<RunDetail | undefined>
    readonly getNode: (
      runId: string,
      nodeName: string,
    ) => Effect.Effect<NodeSnapshot | undefined>
    readonly getFamily: (
      runId: string,
    ) => Effect.Effect<readonly RunFamilyEntry[]>
    /**
     * Emits the run's status changes and ends after the terminal one, or at
     * once when the run does not exist. Each run of the stream watches anew.
     */
    readonly watch: (
      runId: string,
      options?: WorkflowWatchOptions,
    ) => Stream.Stream<WatchEvent>
    readonly pruneRuns: (
      params: PruneTerminalRunsParams,
    ) => Effect.Effect<PruneTerminalRunsResult>
    readonly listDeadCommands: (params?: {
      readonly runId?: string
    }) => Effect.Effect<readonly DeadWorkflowCommand[]>
    readonly requeueDeadCommand: (id: string) => Effect.Effect<void>
    readonly schedules: {
      readonly list: () => Effect.Effect<readonly StoredWorkflowSchedule[]>
      readonly trigger: (name: string) => Effect.Effect<StoredRun>
      readonly setEnabled: (
        name: string,
        enabled: boolean,
      ) => Effect.Effect<StoredWorkflowSchedule>
    }
  }
>()('@nmtjs/workflows/WorkflowClient') {
  // Statics rather than module exports: `@nmtjs/workflows/effect` exports more
  // than this service, where a bare `make` or `layer` would be ambiguous.
  static readonly make: (
    client: WorkflowRuntimeClient,
  ) => WorkflowClient['Service'] = make
  static readonly layer: (
    client: WorkflowRuntimeClient,
  ) => Layer.Layer<WorkflowClient> = layer
}

export const isWorkflowStartError = (
  error: unknown,
): error is WorkflowStartError =>
  error instanceof WorkflowRunConflictError ||
  error instanceof WorkflowIdempotencyConflictError

// Only start conflicts are expected failures; `tryPromise` would make every
// rejection one.
const startAttempt = <A>(
  evaluate: () => Promise<A>,
): Effect.Effect<A, WorkflowStartError> =>
  Effect.callback<A, WorkflowStartError>((resume) => {
    evaluate().then(
      (value) => resume(Effect.succeed(value)),
      (error: unknown) =>
        resume(
          isWorkflowStartError(error) ? Effect.fail(error) : Effect.die(error),
        ),
    )
  })

/**
 * Wraps a Promise client, which keeps owning the adapter: disposing it stays
 * with whoever created it.
 */
function make(client: WorkflowRuntimeClient): WorkflowClient['Service'] {
  const start = Effect.fn('WorkflowClient.start')(function* (
    runnable: AnyWorkflowDefinition | AnyTaskDefinition,
    input: unknown,
    options?: WorkflowStartOptions,
  ) {
    return yield* startAttempt(() =>
      client.start(runnable as AnyWorkflowDefinition, input as never, options),
    )
  })

  return {
    start: start as WorkflowClient['Service']['start'],
    cancel: Effect.fn('WorkflowClient.cancel')(function* (runId: string) {
      return yield* Effect.promise(() => client.cancel(runId))
    }),
    deleteRun: Effect.fn('WorkflowClient.deleteRun')(function* (runId: string) {
      return yield* Effect.promise(() => client.deleteRun(runId))
    }),
    retry: Effect.fn('WorkflowClient.retry')(function* (
      runId: string,
      options?: { readonly expectedVersion?: number },
    ) {
      return yield* Effect.promise(() => client.retry(runId, options))
    }),
    restart: Effect.fn('WorkflowClient.restart')(function* (
      runId: string,
      options?: WorkflowStartOptions,
    ) {
      return yield* startAttempt(() => client.restart(runId, options))
    }),
    get: Effect.fn('WorkflowClient.get')(function* (runId: string) {
      return yield* Effect.promise(() => client.get(runId))
    }),
    list: Effect.fn('WorkflowClient.list')(function* (filter?: ListRunsFilter) {
      return yield* Effect.promise(() => client.list(filter))
    }),
    listSummaries: Effect.fn('WorkflowClient.listSummaries')(function* (
      filter?: ListRunsFilter,
    ) {
      return yield* Effect.promise(() => client.listSummaries(filter))
    }),
    getDetail: Effect.fn('WorkflowClient.getDetail')(function* (runId: string) {
      return yield* Effect.promise(() => client.getDetail(runId))
    }),
    getNode: Effect.fn('WorkflowClient.getNode')(function* (
      runId: string,
      nodeName: string,
    ) {
      return yield* Effect.promise(() => client.getNode(runId, nodeName))
    }),
    getFamily: Effect.fn('WorkflowClient.getFamily')(function* (runId: string) {
      return yield* Effect.promise(() => client.getFamily(runId))
    }),
    watch: (runId, options) =>
      Stream.fromAsyncIterable(
        releasableWatch(client, runId, options),
        (cause) => cause,
      ).pipe(Stream.orDie),
    pruneRuns: Effect.fn('WorkflowClient.pruneRuns')(function* (
      params: PruneTerminalRunsParams,
    ) {
      return yield* Effect.promise(() => client.pruneRuns(params))
    }),
    listDeadCommands: Effect.fn('WorkflowClient.listDeadCommands')(
      function* (params?: { readonly runId?: string }) {
        return yield* Effect.promise(() => client.listDeadCommands(params))
      },
    ),
    requeueDeadCommand: Effect.fn('WorkflowClient.requeueDeadCommand')(
      function* (id: string) {
        return yield* Effect.promise(() => client.requeueDeadCommand(id))
      },
    ),
    schedules: {
      list: Effect.fn('WorkflowClient.schedules.list')(function* () {
        return yield* Effect.promise(() => client.schedules.list())
      }),
      trigger: Effect.fn('WorkflowClient.schedules.trigger')(function* (
        name: string,
      ) {
        return yield* Effect.promise(() => client.schedules.trigger(name))
      }),
      setEnabled: Effect.fn('WorkflowClient.schedules.setEnabled')(function* (
        name: string,
        enabled: boolean,
      ) {
        return yield* Effect.promise(() =>
          client.schedules.setEnabled(name, enabled),
        )
      }),
    },
  }
}

// Effect awaits `return()` when a stream's scope closes, and the watch's
// `return()` queues behind a `next()` that is waiting for the next poll or
// wake. Aborting first ends that wait, so an idle watch can be interrupted. The
// controller is made per iteration, so every run of the stream watches anew.
function releasableWatch(
  client: WorkflowRuntimeClient,
  runId: string,
  options: WorkflowWatchOptions | undefined,
): AsyncIterable<WatchEvent> {
  return {
    [Symbol.asyncIterator]() {
      const controller = new AbortController()
      const iterator = client
        .watch(runId, { ...options, signal: controller.signal })
        [Symbol.asyncIterator]()
      return {
        next: () => iterator.next(),
        return: async (value) => {
          controller.abort()
          return (await iterator.return?.(value)) ?? { done: true, value }
        },
      }
    },
  }
}

/** The client's adapter lifetime stays with whoever built it. */
function layer(client: WorkflowRuntimeClient): Layer.Layer<WorkflowClient> {
  return Layer.succeed(WorkflowClient, make(client))
}
