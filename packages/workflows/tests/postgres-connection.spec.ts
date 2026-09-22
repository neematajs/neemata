import { PGlite } from '@electric-sql/pglite'
import { describe, expect, test } from 'vitest'

import {
  createPostgresWorkflowConnection,
  createPostgresWorkflowRuntime,
  type WorkflowPostgresConnection,
  type WorkflowPostgresQueryResult,
} from '../src/adapters/postgres.ts'
import { installPostgresWorkflowSchemaForTesting } from '../src/adapters/postgres/testing.ts'

type Row = Record<string, unknown>

// The shape of a single `pg.Client`: one session, no transaction API.
const createPlainClient = (db: PGlite) => ({
  query: <T extends Row = Row>(sql: string, params: readonly unknown[] = []) =>
    db.query<T>(sql, [...params]),
})

async function rows<T extends Row>(
  connection: WorkflowPostgresConnection,
  sql: string,
  params: readonly unknown[] = [],
) {
  return (await connection.query<T>(sql, params)).rows
}

const count = async (connection: WorkflowPostgresConnection, table: string) =>
  (
    await connection.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM ${table}`,
    )
  ).rows[0]!.count

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

test('adapts pglite transaction API', async () => {
  const connection = createPostgresWorkflowConnection(new PGlite())

  await connection.query('CREATE TABLE sample (id integer PRIMARY KEY)')
  await connection.transaction(async (tx) => {
    await tx.query('INSERT INTO sample (id) VALUES ($1)', [1])
  })

  await expect(
    connection.transaction(async (tx) => {
      await tx.query('INSERT INTO sample (id) VALUES ($1)', [2])
      throw new Error('rollback')
    }),
  ).rejects.toThrow('rollback')

  const result = await connection.query<{ id: number }>(
    'SELECT id FROM sample ORDER BY id',
  )
  expect(result.rows).toEqual([{ id: 1 }])
})

test('adapts pg pool transactions with connect/release', async () => {
  const log: string[] = []
  const client = {
    async query(sql: string, params: readonly unknown[] = []) {
      log.push(sql)
      return { rows: [{ value: params[0] }] }
    },
    release() {
      log.push('release')
    },
  }
  const pool = {
    totalCount: 0,
    async query() {
      throw new Error('pool query should not run inside transaction')
    },
    async connect() {
      log.push('connect')
      return client
    },
  }
  const connection = createPostgresWorkflowConnection(pool)

  const result = await connection.transaction(async (tx) => {
    const query = await tx.query<{ value: unknown }>('SELECT $1', ['ok'])
    return query.rows[0]?.value
  })

  expect(result).toBe('ok')
  expect(log).toEqual(['connect', 'BEGIN', 'SELECT $1', 'COMMIT', 'release'])
})

test('rolls back pg pool transactions and releases client', async () => {
  const log: string[] = []
  const client = {
    async query(sql: string) {
      log.push(sql)
      return { rows: [] }
    },
    release() {
      log.push('release')
    },
  }
  const pool = {
    totalCount: 0,
    async query() {
      throw new Error('pool query should not run inside transaction')
    },
    async connect() {
      log.push('connect')
      return client
    },
  }
  const connection = createPostgresWorkflowConnection(pool)

  await expect(
    connection.transaction(async (tx) => {
      await tx.query('INSERT')
      throw new Error('boom')
    }),
  ).rejects.toThrow('boom')

  expect(log).toEqual(['connect', 'BEGIN', 'INSERT', 'ROLLBACK', 'release'])
})

test('adapts pg client shape with connect method as plain query client', async () => {
  const log: string[] = []
  const client = {
    async connect() {
      log.push('connect')
    },
    async query<T extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<WorkflowPostgresQueryResult<T>> {
      log.push(sql)
      return { rows: [{ value: params[0] } as unknown as T] }
    },
  }
  const connection = createPostgresWorkflowConnection(client)

  const result = await connection.transaction(async (tx) => {
    const query = await tx.query<{ value: unknown }>('SELECT $1', ['ok'])
    return query.rows[0]?.value
  })

  expect(result).toBe('ok')
  expect(log).toEqual(['BEGIN', 'SELECT $1', 'COMMIT'])
})

test('serializes plain query client transactions', async () => {
  const log: string[] = []
  let releaseFirst!: () => void
  let firstInsertStarted!: () => void
  const firstInsert = new Promise<void>((resolve) => {
    firstInsertStarted = resolve
  })
  const releaseFirstInsert = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  const client = {
    async query(sql: string) {
      log.push(sql)
      if (sql === 'INSERT first') {
        firstInsertStarted()
        await releaseFirstInsert
      }
      return { rows: [] }
    },
  }
  const connection = createPostgresWorkflowConnection(client)

  const first = connection.transaction(async (tx) => {
    await tx.query('INSERT first')
    return 'first'
  })
  await firstInsert

  const second = connection.transaction(async (tx) => {
    log.push('second handler')
    await tx.query('INSERT second')
    return 'second'
  })
  await Promise.resolve()

  expect(log).toEqual(['BEGIN', 'INSERT first'])
  releaseFirst()

  await expect(Promise.all([first, second])).resolves.toEqual([
    'first',
    'second',
  ])
  expect(log).toEqual([
    'BEGIN',
    'INSERT first',
    'COMMIT',
    'BEGIN',
    'second handler',
    'INSERT second',
    'COMMIT',
  ])
})

test('releases pg pool client when begin fails', async () => {
  const log: string[] = []
  const client = {
    async query(sql: string) {
      log.push(sql)
      throw new Error('begin failed')
    },
    release() {
      log.push('release')
    },
  }
  const pool = {
    totalCount: 0,
    async query() {
      throw new Error('pool query should not run inside transaction')
    },
    async connect() {
      log.push('connect')
      return client
    },
  }
  const connection = createPostgresWorkflowConnection(pool)

  await expect(
    connection.transaction(async () => 'unreachable'),
  ).rejects.toThrow('begin failed')

  expect(log).toEqual(['connect', 'BEGIN', 'ROLLBACK', 'release'])
})

test('preserves original transaction error when rollback fails', async () => {
  const log: string[] = []
  const client = {
    async query(sql: string) {
      log.push(sql)
      if (sql === 'ROLLBACK') throw new Error('rollback failed')
      return { rows: [] }
    },
  }
  const connection = createPostgresWorkflowConnection(client)

  await expect(
    connection.transaction(async (tx) => {
      await tx.query('INSERT')
      throw new Error('handler failed')
    }),
  ).rejects.toThrow('handler failed')

  expect(log).toEqual(['BEGIN', 'INSERT', 'ROLLBACK'])
})

describe('plain client sessions', () => {
  test('a plain client keeps a top-level write out of another caller’s transaction', async () => {
    const connection = createPostgresWorkflowConnection(
      createPlainClient(new PGlite()),
    )
    await connection.query('CREATE TABLE sample (id integer PRIMARY KEY)')

    let markSuspended!: () => void
    const suspended = new Promise<void>((resolve) => {
      markSuspended = resolve
    })
    let resume!: () => void
    const resumed = new Promise<void>((resolve) => {
      resume = resolve
    })

    const transaction = connection.transaction(async (tx) => {
      await tx.query('INSERT INTO sample (id) VALUES (1)')
      markSuspended()
      await resumed
      throw new Error('rollback')
    })
    await suspended
    const write = connection.query('INSERT INTO sample (id) VALUES (2)')
    resume()

    await expect(transaction).rejects.toThrow('rollback')
    await write
    expect(await rows(connection, 'SELECT id FROM sample')).toEqual([{ id: 2 }])
  })
})

describe('nested transactions as savepoints', () => {
  test.each([
    ['a client transaction API', (db: PGlite) => db],
    ['a plain client', createPlainClient],
  ])(
    'a nested transaction is a rollback boundary on %s',
    async (_name, createClient) => {
      const connection = createPostgresWorkflowConnection(
        createClient(new PGlite()),
      )
      await connection.query('CREATE TABLE sample (id integer PRIMARY KEY)')

      await connection.transaction(async (tx) => {
        await tx.query('INSERT INTO sample (id) VALUES (1)')
        await expect(
          tx.transaction(async (nested) => {
            await nested.query('INSERT INTO sample (id) VALUES (2)')
            await nested.transaction(async (inner) => {
              await inner.query('INSERT INTO sample (id) VALUES (3)')
            })
            // a failed statement aborts the transaction up to the savepoint
            await nested.query('INSERT INTO sample (id) VALUES (1)')
          }),
        ).rejects.toThrow()
        await tx.transaction(async (nested) => {
          await nested.query('INSERT INTO sample (id) VALUES (4)')
        })
      })

      expect(
        await rows(connection, 'SELECT id FROM sample ORDER BY id'),
      ).toEqual([{ id: 1 }, { id: 4 }])
    },
  )
})

describe.each([
  ['a transaction-API client', (db: PGlite) => db],
  ['a plain client', createPlainClient],
] as const)('nested transactions over %s', (_name, createClient) => {
  async function createSample() {
    const connection = createPostgresWorkflowConnection(
      createClient(new PGlite()),
    )
    await connection.query('CREATE TABLE sample (id integer PRIMARY KEY)')
    const ids = async (db: WorkflowPostgresConnection = connection) =>
      (
        await db.query<{ id: number }>('SELECT id FROM sample ORDER BY id')
      ).rows.map((row) => row.id)
    return { connection, ids }
  }

  test('a failed sibling scope does not undo an overlapping one', async () => {
    const { connection, ids } = await createSample()
    const inserted = deferred()
    const fail = deferred()

    await connection.transaction(async (tx) => {
      const failing = tx.transaction(async (a) => {
        await a.query('INSERT INTO sample (id) VALUES (1)')
        inserted.resolve()
        await fail.promise
        throw new Error('rollback A')
      })
      await inserted.promise
      const succeeding = tx.transaction(async (b) => {
        await b.query('INSERT INTO sample (id) VALUES (2)')
      })
      // Give B every chance to overlap A before A fails.
      await tick()
      fail.resolve()
      await expect(failing).rejects.toThrow('rollback A')
      await succeeding
    })

    expect(await ids()).toStrictEqual([2])
  })

  test('a parent-level query waits for an open scope instead of joining it', async () => {
    const { connection, ids } = await createSample()
    const inserted = deferred()
    const fail = deferred()

    await connection.transaction(async (tx) => {
      const failing = tx.transaction(async (a) => {
        await a.query('INSERT INTO sample (id) VALUES (1)')
        inserted.resolve()
        await fail.promise
        throw new Error('rollback A')
      })
      await inserted.promise
      const parentWrite = tx.query('INSERT INTO sample (id) VALUES (3)')
      await tick()
      fail.resolve()
      await expect(failing).rejects.toThrow('rollback A')
      await parentWrite
    })

    expect(await ids()).toStrictEqual([3])
  })

  test('a scope’s own queries and nested scopes do not wait on the scope', async () => {
    const { connection, ids } = await createSample()

    await connection.transaction(async (tx) => {
      await tx.transaction(async (a) => {
        await a.query('INSERT INTO sample (id) VALUES (1)')
        await a
          .transaction(async (inner) => {
            await inner.query('INSERT INTO sample (id) VALUES (2)')
            throw new Error('rollback inner')
          })
          .catch(() => {})
        await a.transaction(async (inner) => {
          await inner.query('INSERT INTO sample (id) VALUES (3)')
        })
        expect(await ids(a)).toStrictEqual([1, 3])
      })
      // The queue is released by a scope that ends either way.
      expect(await ids(tx)).toStrictEqual([1, 3])
    })

    expect(await ids()).toStrictEqual([1, 3])
  })
})

describe.each([
  ['a transaction-API client', (db: PGlite) => db],
  ['a plain client', createPlainClient],
] as const)('ended transaction scopes over %s', (_name, createClient) => {
  async function createSample() {
    const connection = createPostgresWorkflowConnection(
      createClient(new PGlite()),
    )
    await connection.query('CREATE TABLE sample (id integer PRIMARY KEY)')
    return connection
  }

  test('a run started beside a failing sibling is rolled back with the outer transaction', async () => {
    const connection = await createSample()
    await installPostgresWorkflowSchemaForTesting(connection)
    const runtime = createPostgresWorkflowRuntime({ connection })
    let started: Promise<unknown> | undefined

    await expect(
      connection.transaction(async (tx) => {
        await tx.query('INSERT INTO sample (id) VALUES (1)')
        // The failing scope takes the connection first, so the start is still
        // queued behind it when `Promise.all` rejects.
        const failing = tx.transaction(async () => {
          throw new Error('sibling failed')
        })
        started = runtime.atomicStart!.startWorkflowRun({
          connection: tx,
          run: { workflowName: 'ended-scope-start', input: {} },
        })
        await Promise.all([failing, started])
      }),
    ).rejects.toThrow('sibling failed')

    await Promise.allSettled([started])
    await tick()
    expect(await count(connection, 'sample')).toBe(0)
    expect(await count(connection, 'workflow_runs')).toBe(0)
    expect(await count(connection, 'workflow_commands')).toBe(0)
  })

  test('work still running when the handler fails is undone and cut short', async () => {
    const connection = await createSample()
    let floating: Promise<unknown> | undefined

    await expect(
      connection.transaction(async (tx) => {
        floating = (async () => {
          await tx.query('INSERT INTO sample (id) VALUES (1)')
          await tx.query('INSERT INTO sample (id) VALUES (2)')
        })()
        throw new Error('handler failed')
      }),
    ).rejects.toThrow('handler failed')

    await expect(floating).rejects.toThrow('has already ended')
    await tick()
    expect(await count(connection, 'sample')).toBe(0)
  })

  test('work queued before the handler returns is committed with it', async () => {
    const connection = await createSample()
    let floating: Promise<unknown> | undefined

    await connection.transaction(async (tx) => {
      floating = tx.transaction(async (nested) => {
        await nested.query('INSERT INTO sample (id) VALUES (1)')
        await tick()
        await nested.query('INSERT INTO sample (id) VALUES (2)')
      })
    })

    await floating
    expect(await count(connection, 'sample')).toBe(2)
  })

  test('a connection rejects queries and scopes once its transaction ended', async () => {
    const connection = await createSample()
    const scopes: WorkflowPostgresConnection[] = []

    await connection.transaction(async (tx) => {
      scopes.push(tx)
      await tx.transaction(async (nested) => {
        scopes.push(nested)
        // The savepoint is still open here, and so is its parent.
        await nested.query('INSERT INTO sample (id) VALUES (1)')
      })
      await expect(
        scopes[1]!.query('INSERT INTO sample (id) VALUES (2)'),
      ).rejects.toThrow('has already ended')
      await tx.query('INSERT INTO sample (id) VALUES (3)')
    })
    await connection
      .transaction(async (tx) => {
        scopes.push(tx)
        throw new Error('rolled back')
      })
      .catch(() => {})

    for (const scope of scopes) {
      await expect(
        scope.query('INSERT INTO sample (id) VALUES (4)'),
      ).rejects.toThrow('has already ended')
      await expect(
        scope.transaction(async (nested) => {
          await nested.query('INSERT INTO sample (id) VALUES (5)')
        }),
      ).rejects.toThrow('has already ended')
    }
    const rows = await connection.query<{ id: number }>(
      'SELECT id FROM sample ORDER BY id',
    )
    expect(rows.rows.map((row) => row.id)).toStrictEqual([1, 3])
  })
})
