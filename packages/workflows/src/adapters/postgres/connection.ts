type JsonRecord = Record<string, unknown>

export type WorkflowPostgresQueryResult<T extends JsonRecord = JsonRecord> = {
  readonly rows: readonly T[]
}

export type WorkflowPostgresConnection = {
  query<T extends JsonRecord = JsonRecord>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<WorkflowPostgresQueryResult<T>>
  transaction<T>(
    handler: (connection: WorkflowPostgresConnection) => Promise<T>,
  ): Promise<T>
}

export type WorkflowPostgresQueryClient = {
  query<T extends JsonRecord = JsonRecord>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<WorkflowPostgresQueryResult<T>>
}

export type WorkflowPostgresPoolClient = WorkflowPostgresQueryClient & {
  /** Discard the session instead of returning it to the pool when true. */
  release(destroy?: boolean): void
  /** `pg`'s session events: a failed socket discards the session. */
  on?(event: 'error', listener: (error: Error) => void): unknown
  removeListener?(event: 'error', listener: (error: Error) => void): unknown
}

export type WorkflowPostgresPool = WorkflowPostgresQueryClient & {
  connect(): Promise<WorkflowPostgresPoolClient>
}

export type WorkflowPostgresTransactionClient = WorkflowPostgresQueryClient & {
  transaction<T>(
    handler: (connection: WorkflowPostgresQueryClient) => Promise<T>,
  ): Promise<T>
}

export type CreatePostgresWorkflowConnectionOptions = {
  /**
   * How long PostgreSQL has to answer each statement the engine sends through
   * a pool, in milliseconds. A statement that misses it fails and its session
   * is discarded instead of returned to the pool. Idle sessions and waiting
   * for a free session are not bounded by it. Only pools accept it: the
   * adapter cannot discard sessions of other clients.
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

type WorkflowPostgresExternalClient =
  | WorkflowPostgresQueryClient
  | WorkflowPostgresPool
  | WorkflowPostgresTransactionClient

const hasTransactionApi = (
  client: WorkflowPostgresExternalClient,
): client is WorkflowPostgresTransactionClient =>
  'transaction' in client && typeof client.transaction === 'function'

const hasConnectApi = (
  client: WorkflowPostgresExternalClient,
): client is WorkflowPostgresPool =>
  'connect' in client &&
  typeof client.connect === 'function' &&
  ('totalCount' in client || 'idleCount' in client || 'waitingCount' in client)

const queryPostgresClient = <T extends JsonRecord>(
  client: WorkflowPostgresQueryClient,
  sql: string,
  params: readonly unknown[] = [],
) => client.query<T>(sql, [...params])

// Only an error the server sent proves the session answered and is back in
// sync. A driver's read timeout or a lost socket may leave the statement in
// flight, with anything sent after it queued behind.
const isServerError = (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  'severity' in error &&
  typeof error.severity === 'string'

type BorrowedSession = {
  readonly session: WorkflowPostgresQueryClient
  /** Idempotent: a session discarded while in use is already released. */
  readonly release: (destroy: boolean) => void
}

// A session that became unusable is discarded at once rather than when its
// owner finishes: a handler that catches the failure and carries on would
// otherwise hold the unanswered statement, its locks and the pool slot. Every
// later statement on it fails at once; a ROLLBACK would only queue behind the
// unanswered statement.
const borrowPooledSession = async (
  pool: WorkflowPostgresPool,
  answerTimeoutMs: number | undefined,
): Promise<BorrowedSession> => {
  const client = await pool.connect()
  let released = false
  let unusable: { readonly error: unknown } | undefined
  const release = (destroy: boolean) => {
    if (released) return
    released = true
    client.release(destroy)
    // Removed only after the pool took the session back and attached its own.
    client.removeListener?.('error', onError)
  }
  const discard = (error: unknown) => {
    unusable ??= { error }
    release(true)
  }
  // A checked-out `pg` client has no error listener of its own, so a socket
  // failure would otherwise be an unhandled `error` event.
  const onError = (error: unknown) => discard(error)
  client.on?.('error', onError)

  const query = <T extends JsonRecord>(
    sql: string,
    params?: readonly unknown[],
  ) =>
    new Promise<WorkflowPostgresQueryResult<T>>((resolve, reject) => {
      if (unusable) return reject(unusable.error)
      const answer = client.query<T>(sql, params)
      const timer =
        answerTimeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              const error = new Error(
                `PostgreSQL did not answer a workflow statement within ${answerTimeoutMs} ms; its session is discarded`,
              )
              discard(error)
              reject(error)
            }, answerTimeoutMs)
      answer.then(
        (result) => {
          clearTimeout(timer)
          resolve(result)
        },
        (error: unknown) => {
          clearTimeout(timer)
          if (!isServerError(error)) discard(error)
          reject(error)
        },
      )
    })
  return { session: { query }, release }
}

const createSerializer = () => {
  let queue = Promise.resolve()
  const run = async <T>(handler: () => Promise<T>): Promise<T> => {
    const previous = queue
    let release = () => {}
    queue = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await handler()
    } finally {
      release()
    }
  }
  return { run, settled: () => queue }
}

const scopeEndedError = () =>
  new Error(
    'The workflow PostgreSQL transaction that owns this connection has already ended. Await all work on a transaction connection before its handler settles',
  )

// Store methods open a transaction to undo partial work on a recoverable
// failure and cannot know whether a caller already holds one, so a nested
// transaction must be a rollback boundary of its own rather than a plain call.
//
// Savepoints form a stack on one session: a sibling scope or a parent-level
// query that overlapped an open scope would run inside that scope's savepoint
// and be undone, or kept, by its outcome. Each connection therefore runs its
// scopes and queries one at a time, while a scope's own connection has its own
// queue, so work inside the scope never waits on the scope itself. The cost is
// that a scope must not await its parent connection: that waits on itself.
const createTransactionScope = (
  client: WorkflowPostgresQueryClient,
  depth = 0,
) => {
  const serializer = createSerializer()
  let ended = false
  const serialize = <T>(handler: () => Promise<T>): Promise<T> =>
    ended ? Promise.reject(scopeEndedError()) : serializer.run(handler)

  const connection: WorkflowPostgresConnection = {
    query: (sql, params = []) =>
      serialize(() => queryPostgresClient(client, sql, params)),
    transaction: (handler) =>
      serialize(async () => {
        const savepoint = `workflow_savepoint_${depth + 1}`
        await client.query(`SAVEPOINT ${savepoint}`)
        let result: Awaited<ReturnType<typeof handler>>
        try {
          result = await runTransactionScope(client, handler, depth + 1)
        } catch (error) {
          // Rolling back also clears the aborted state a failed statement leaves
          // behind, so the enclosing transaction stays usable for recovery reads.
          try {
            await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`)
            await client.query(`RELEASE SAVEPOINT ${savepoint}`)
          } catch {}
          throw error
        }
        await client.query(`RELEASE SAVEPOINT ${savepoint}`)
        return result
      }),
  }

  return {
    connection,
    async end() {
      ended = true
      await serializer.settled()
    },
  }
}

// A handler can settle while work it started is still running: `Promise.all`
// rejects on the first failure and leaves the sibling going. That sibling's
// later statements would reach the session after the transaction ended and
// commit on their own, so the scope refuses new work as soon as its handler
// settles, and whatever is already queued finishes before the caller finalizes.
const runTransactionScope = async <T>(
  client: WorkflowPostgresQueryClient,
  handler: (connection: WorkflowPostgresConnection) => Promise<T>,
  depth = 0,
): Promise<T> => {
  const scope = createTransactionScope(client, depth)
  try {
    return await handler(scope.connection)
  } finally {
    await scope.end()
  }
}

export function createPostgresWorkflowConnection(
  client: WorkflowPostgresExternalClient,
  options: CreatePostgresWorkflowConnectionOptions = {},
): WorkflowPostgresConnection {
  const answerTimeoutMs = normalizeAnswerTimeoutMs(options.answerTimeoutMs)
  if (
    answerTimeoutMs !== undefined &&
    (hasTransactionApi(client) || !hasConnectApi(client))
  ) {
    throw new TypeError(
      'answerTimeoutMs requires a pool: only a pooled session can be discarded after a statement goes unanswered',
    )
  }

  // A plain client is one session: anything it runs while a transaction is
  // open joins that transaction and is lost with its rollback. Top-level
  // queries therefore wait their turn with transactions; queries made through
  // the transaction-scoped connection go straight to the client.
  const serializeClient = createSerializer().run

  async function runTransaction<T>(
    connection: WorkflowPostgresQueryClient,
    handler: (connection: WorkflowPostgresConnection) => Promise<T>,
    release?: (destroy: boolean) => void,
  ): Promise<T> {
    let destroy = false
    try {
      await connection.query('BEGIN')
      const result = await runTransactionScope(connection, handler)
      await connection.query('COMMIT')
      return result
    } catch (error) {
      try {
        await connection.query('ROLLBACK')
      } catch {
        // Its transaction state is unknown: never lend this session to another
        // caller, but preserve the original failure for the transaction owner.
        destroy = true
      }
      throw error
    } finally {
      release?.(destroy)
    }
  }

  const serializesQueries = !hasTransactionApi(client) && !hasConnectApi(client)

  return {
    async query<T extends JsonRecord = JsonRecord>(
      sql: string,
      params: readonly unknown[] = [],
    ) {
      if (serializesQueries) {
        return serializeClient(() =>
          queryPostgresClient<T>(client, sql, params),
        )
      }
      // `pool.query` would pick a session the adapter cannot discard.
      if (answerTimeoutMs !== undefined && hasConnectApi(client)) {
        const { session, release } = await borrowPooledSession(
          client,
          answerTimeoutMs,
        )
        let result: WorkflowPostgresQueryResult<T>
        try {
          result = await queryPostgresClient<T>(session, sql, params)
        } catch (error) {
          // As `pool.query` does: nothing is lost by replacing the session.
          release(true)
          throw error
        }
        release(false)
        return result
      }
      return queryPostgresClient<T>(client, sql, params)
    },
    async transaction(handler) {
      if (hasTransactionApi(client)) {
        return client.transaction((tx) => runTransactionScope(tx, handler))
      }

      if (hasConnectApi(client)) {
        const { session, release } = await borrowPooledSession(
          client,
          answerTimeoutMs,
        )
        return runTransaction(session, handler, release)
      }

      return serializeClient(() => runTransaction(client, handler))
    },
  }
}
