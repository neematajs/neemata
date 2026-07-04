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

const createTransactionConnection = (
  client: WorkflowPostgresQueryClient,
): WorkflowPostgresConnection => ({
  query: (sql, params = []) => queryPostgresClient(client, sql, params),
  transaction: (handler) => handler(createTransactionConnection(client)),
})

const rollbackIgnoringFailure = async (client: WorkflowPostgresQueryClient) => {
  try {
    await client.query('ROLLBACK')
  } catch {}
}

export function createPostgresWorkflowConnection(
  client: WorkflowPostgresExternalClient,
): WorkflowPostgresConnection {
  let plainClientTransactionQueue = Promise.resolve()
  const runPlainClientTransaction = async <T>(
    handler: () => Promise<T>,
  ): Promise<T> => {
    const previous = plainClientTransactionQueue
    let release = () => {}
    plainClientTransactionQueue = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await handler()
    } finally {
      release()
    }
  }

  return {
    query: (sql, params = []) => queryPostgresClient(client, sql, params),
    async transaction(handler) {
      if (hasTransactionApi(client)) {
        return client.transaction((tx) =>
          handler(createTransactionConnection(tx)),
        )
      }

      if (hasConnectApi(client)) {
        const tx = await client.connect()
        try {
          await tx.query('BEGIN')
          const result = await handler(createTransactionConnection(tx))
          await tx.query('COMMIT')
          return result
        } catch (error) {
          await rollbackIgnoringFailure(tx)
          throw error
        } finally {
          tx.release()
        }
      }

      return runPlainClientTransaction(async () => {
        try {
          await client.query('BEGIN')
          const result = await handler(createTransactionConnection(client))
          await client.query('COMMIT')
          return result
        } catch (error) {
          await rollbackIgnoringFailure(client)
          throw error
        }
      })
    },
  }
}
