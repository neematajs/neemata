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
  release(): void
}

export type WorkflowPostgresPool = WorkflowPostgresQueryClient & {
  connect(): Promise<WorkflowPostgresPoolClient>
}

export type WorkflowPostgresTransactionClient = WorkflowPostgresQueryClient & {
  transaction<T>(
    handler: (connection: WorkflowPostgresQueryClient) => Promise<T>,
  ): Promise<T>
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

const rollbackIgnoringFailure = async (client: WorkflowPostgresQueryClient) => {
  try {
    await client.query('ROLLBACK')
  } catch {}
}

export function createPostgresWorkflowConnection(
  client: WorkflowPostgresExternalClient,
): WorkflowPostgresConnection {
  // A plain client is one session: anything it runs while a transaction is
  // open joins that transaction and is lost with its rollback. Top-level
  // queries therefore wait their turn with transactions; queries made through
  // the transaction-scoped connection go straight to the client.
  const serializeClient = createSerializer().run

  const runTransaction = async <T>(
    connection: WorkflowPostgresQueryClient,
    handler: (connection: WorkflowPostgresConnection) => Promise<T>,
  ): Promise<T> => {
    try {
      await connection.query('BEGIN')
      const result = await runTransactionScope(connection, handler)
      await connection.query('COMMIT')
      return result
    } catch (error) {
      await rollbackIgnoringFailure(connection)
      throw error
    }
  }

  const serializesQueries = !hasTransactionApi(client) && !hasConnectApi(client)

  return {
    query: (sql, params = []) =>
      serializesQueries
        ? serializeClient(() => queryPostgresClient(client, sql, params))
        : queryPostgresClient(client, sql, params),
    async transaction(handler) {
      if (hasTransactionApi(client)) {
        return client.transaction((tx) => runTransactionScope(tx, handler))
      }

      if (hasConnectApi(client)) {
        const tx = await client.connect()
        try {
          return await runTransaction(tx, handler)
        } finally {
          tx.release()
        }
      }

      return serializeClient(() => runTransaction(client, handler))
    },
  }
}
