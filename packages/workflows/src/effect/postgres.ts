import type * as Context from 'effect/Context'
import * as Cause from 'effect/Cause'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Option from 'effect/Option'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlError from 'effect/sql/SqlError'

import type {
  WorkflowPostgresConnection,
  WorkflowPostgresQueryClient,
  WorkflowPostgresQueryResult,
} from '../adapters/postgres/connection.ts'
import type {
  WorkflowRuntimeClient,
  WorkflowRuntimeStartOptions,
} from '../runtime/client.ts'
import type {
  AnyTaskDefinition,
  AnyWorkflowDefinition,
  RunnableRun,
  TaskInput,
  TaskRun,
  WorkflowInput,
  WorkflowRun,
} from '../types/index.ts'
import { createPostgresWorkflowNestedConnection } from '../adapters/postgres/connection.ts'
import {
  WorkflowIdempotencyConflictError,
  WorkflowRunConflictError,
} from '../runtime/errors.ts'

export type EffectSqlWorkflowStartOptions = Omit<
  WorkflowRuntimeStartOptions,
  'connection'
>

export type EffectSqlWorkflowStartError =
  | WorkflowRunConflictError
  | WorkflowIdempotencyConflictError
  | SqlError.SqlError

export type EffectSqlWorkflowClient = {
  /**
   * Starts a run. Inside an open Effect SQL transaction, run creation and
   * dispatch join it through a savepoint, so they commit or roll back with the
   * caller's writes and the returned run is provisional until that commit.
   * Outside one, it starts the run like the Promise client.
   */
  readonly start: {
    <Workflow extends AnyWorkflowDefinition>(
      workflow: Workflow,
      input: WorkflowInput<Workflow>,
      options?: EffectSqlWorkflowStartOptions,
    ): Effect.Effect<
      WorkflowRun<Workflow>,
      EffectSqlWorkflowStartError,
      SqlClient.SqlClient
    >
    <Task extends AnyTaskDefinition>(
      task: Task,
      input: TaskInput<Task>,
      options?: EffectSqlWorkflowStartOptions,
    ): Effect.Effect<
      TaskRun<Task>,
      EffectSqlWorkflowStartError,
      SqlClient.SqlClient
    >
  }
  /** Resubmits a terminal run; joins an open transaction like `start`. */
  readonly restart: (
    runId: string,
    options?: EffectSqlWorkflowStartOptions,
  ) => Effect.Effect<
    RunnableRun,
    EffectSqlWorkflowStartError,
    SqlClient.SqlClient
  >
}

export type CreateEffectSqlWorkflowClientOptions = {
  /**
   * How long PostgreSQL has to answer each statement of a start that joins the
   * caller's transaction, in milliseconds. A statement that misses it is
   * cancelled and the start fails with a `StatementTimeoutError` reason. The
   * savepoint statements Effect SQL sends around the start are not covered.
   */
  readonly answerTimeoutMs?: number
}

// Node fires longer timers after 1 ms instead.
const MAX_TIMER_MS = 2_147_483_647

const normalizeAnswerTimeoutMs = (answerTimeoutMs: number | undefined) => {
  if (answerTimeoutMs === undefined) return undefined

  if (
    !Number.isSafeInteger(answerTimeoutMs) ||
    answerTimeoutMs <= 0 ||
    answerTimeoutMs > MAX_TIMER_MS
  ) {
    throw new RangeError(
      `answerTimeoutMs must be a positive integer of at most ${MAX_TIMER_MS}`,
    )
  }

  return answerTimeoutMs
}

const sessionClosedError = () =>
  new Error(
    'The Effect SQL transaction this workflow start joined has moved on. Await all work on the start connection before it settles',
  )

const answerTimeoutError = (answerTimeoutMs: number) => {
  const message = `PostgreSQL did not answer a workflow statement within ${answerTimeoutMs} ms`

  return new SqlError.SqlError({
    reason: new SqlError.StatementTimeoutError({
      cause: new Error(message),
      message,
      operation: 'workflowStart',
    }),
  })
}

// Statements run as fibers of their own with the caller's services, so they
// find its transaction connection; interrupting one makes the driver cancel it
// on the server.
const createTransactionSession = (
  sql: SqlClient.SqlClient,
  context: Context.Context<never>,
  answerTimeoutMs: number | undefined,
) => {
  const statements = new Set<Fiber.Fiber<unknown, unknown>>()
  let closed = false
  const client = sql.withoutTransforms()

  const session: WorkflowPostgresQueryClient = {
    query<T extends Record<string, unknown>>(
      text: string,
      params: readonly unknown[] = [],
    ) {
      if (closed) return Promise.reject(sessionClosedError())

      const statement = client.unsafe<T>(text, params)

      const fiber = Effect.runForkWith(context)(
        answerTimeoutMs === undefined
          ? statement
          : statement.pipe(
              Effect.timeoutOrElse({
                duration: Duration.millis(answerTimeoutMs),
                orElse: () => Effect.fail(answerTimeoutError(answerTimeoutMs)),
              }),
            ),
      )

      statements.add(fiber)

      return new Promise<WorkflowPostgresQueryResult<T>>((resolve, reject) => {
        fiber.addObserver((exit) => {
          statements.delete(fiber)
          if (Exit.isSuccess(exit)) resolve({ rows: exit.value })
          else reject(Cause.squash(exit.cause))
        })
      })
    },
  }

  return {
    session,
    close: () => {
      closed = true
    },

    interrupt: Effect.suspend(() => {
      closed = true
      return Fiber.interruptAll(Array.from(statements))
    }),
  }
}

const toStartFailure = (
  error: unknown,
): Effect.Effect<never, EffectSqlWorkflowStartError> =>
  error instanceof WorkflowRunConflictError ||
  error instanceof WorkflowIdempotencyConflictError ||
  SqlError.isSqlError(error)
    ? Effect.fail(error)
    : Effect.die(error)

/**
 * Wraps a Postgres workflow client for Effect SQL applications, so starting a
 * run inside `sql.withTransaction` (or a Drizzle `effect-postgres`
 * transaction) commits or rolls back with the caller's writes on the caller's
 * connection, without a second pool or a Promise transaction API.
 */
export function createEffectSqlWorkflowClient(
  client: WorkflowRuntimeClient<WorkflowPostgresConnection>,
  options: CreateEffectSqlWorkflowClientOptions = {},
): EffectSqlWorkflowClient {
  const answerTimeoutMs = normalizeAnswerTimeoutMs(options.answerTimeoutMs)

  const run = <A>(
    operation: (connection?: WorkflowPostgresConnection) => Promise<A>,
  ): Effect.Effect<A, EffectSqlWorkflowStartError, SqlClient.SqlClient> =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const transaction = yield* Effect.serviceOption(sql.transactionService)

      if (Option.isNone(transaction)) {
        return yield* Effect.callback<A, EffectSqlWorkflowStartError>(
          (resume) => {
            operation().then(
              (value) => resume(Effect.succeed(value)),
              (error: unknown) => resume(toStartFailure(error)),
            )
          },
        )
      }

      // The whole operation runs in a savepoint of Effect's own. Its semaphore
      // serializes it with sibling savepoints, so concurrent starts in one
      // transaction cannot undo each other's work, and its rollback also
      // covers reads made before the adapter opens a savepoint and an
      // interrupted start whose own savepoint rollback was refused.
      return yield* sql.withTransaction(
        Effect.flatMap(Effect.context<never>(), (context) =>
          Effect.callback<A, EffectSqlWorkflowStartError>((resume) => {
            const transactionSession = createTransactionSession(
              sql,
              context,
              answerTimeoutMs,
            )

            const settled = operation(
              createPostgresWorkflowNestedConnection(
                transactionSession.session,
              ),
            ).finally(transactionSession.close)

            settled.then(
              (value) => resume(Effect.succeed(value)),
              (error: unknown) => resume(toStartFailure(error)),
            )

            // The savepoint rolls back once this returns, so the start must
            // have unwound by then: a statement still in flight would race
            // that rollback, and a later one would run outside the savepoint
            // or reach a session already back in the pool.
            return Effect.andThen(
              transactionSession.interrupt,
              Effect.promise(() => settled.then(noop, noop)),
            )
          }),
        ),
      )
    })

  function start(
    runnable: AnyWorkflowDefinition | AnyTaskDefinition,
    input: unknown,
    options?: EffectSqlWorkflowStartOptions,
  ) {
    return run((connection) => {
      return client.start(runnable as AnyWorkflowDefinition, input as never, {
        ...options,
        connection,
      })
    })
  }

  function restart(runId: string, options?: EffectSqlWorkflowStartOptions) {
    return run((connection) => {
      return client.restart(runId, { ...options, connection })
    })
  }

  return {
    start: start as EffectSqlWorkflowClient['start'],
    restart,
  }
}

const noop = () => {}
