import type { AddressInfo } from 'node:net'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:net'

import { PGlite } from '@electric-sql/pglite'
import pg from 'pg'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

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
    release(destroy?: boolean) {
      expect(destroy).not.toBe(true)
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
    release(destroy?: boolean) {
      expect(destroy).not.toBe(true)
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

test.each(['BEGIN', 'handler', 'COMMIT'])(
  'discards a pooled session when rollback after %s failure fails',
  async (stage) => {
    const failure = new Error(`${stage} failed`)
    const release = vi.fn()
    const client = {
      async query(sql: string) {
        if (sql === stage) throw failure
        if (sql === 'ROLLBACK') throw new Error('rollback failed')
        return { rows: [] }
      },
      release,
    }
    const pool = {
      totalCount: 1,
      query: client.query.bind(client),
      async connect() {
        return client
      },
    }
    const connection = createPostgresWorkflowConnection(pool)

    await expect(
      connection.transaction(async () => {
        if (stage === 'handler') throw failure
      }),
    ).rejects.toBe(failure)
    expect(release).toHaveBeenCalledExactlyOnceWith(true)
  },
)

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

// What a fake session does with a statement: answer it, never answer it (like
// a server that stopped replying), or fail it.
type FakeOutcome = 'answer' | 'never' | Error

// Created exactly like this by `pg`'s `query_timeout`.
const readTimeout = () => new Error('Query read timeout')

// Sessions shaped like `pg`'s pool clients: an `error` event nobody listens
// to throws, and a failed socket first fails the statements in flight.
function createPool(outcome: (sql: string) => FakeOutcome = () => 'answer') {
  const log: string[] = []
  const releases: (boolean | undefined)[] = []
  const sessions: (EventEmitter & { fail(error: Error): void })[] = []
  const pool = {
    totalCount: 1,
    async query(): Promise<never> {
      throw new Error('pool.query picks a session the adapter cannot discard')
    },
    async connect() {
      log.push('connect')
      const pending = new Set<(error: Error) => void>()
      const session = Object.assign(new EventEmitter(), {
        query(sql: string): Promise<{ rows: [] }> {
          log.push(sql)
          const result = outcome(sql)
          if (result === 'answer') return Promise.resolve({ rows: [] })
          if (result instanceof Error) return Promise.reject(result)
          return new Promise((_, reject) => pending.add(reject))
        },
        release(destroy?: boolean) {
          releases.push(destroy)
        },
        fail(error: Error) {
          for (const reject of pending) reject(error)
          session.emit('error', error)
        },
      })
      sessions.push(session)
      return session
    },
  }
  return { pool, log, releases, sessions }
}

describe('borrowed pool sessions', () => {
  test('discards a transaction session whose socket fails mid-statement', async () => {
    const { pool, log, releases, sessions } = createPool((sql) =>
      sql === 'SELECT 1' ? 'never' : 'answer',
    )
    const connection = createPostgresWorkflowConnection(pool)
    const lost = new Error('Connection terminated unexpectedly')

    const failed = connection
      .transaction(async (tx) => {
        await tx.query('SELECT 1')
      })
      .catch((error: unknown) => error)
    await vi.waitFor(() => expect(log).toContain('SELECT 1'))
    // Without a listener, this `error` event would throw.
    sessions[0]!.fail(lost)

    expect(await failed).toBe(lost)
    expect(log).toStrictEqual(['connect', 'BEGIN', 'SELECT 1'])
    expect(releases).toStrictEqual([true])
    expect(sessions[0]!.listenerCount('error')).toBe(0)
  })

  test('discards a transaction session whose statement hit the driver read timeout', async () => {
    const timedOut = readTimeout()
    const { pool, log, releases } = createPool((sql) =>
      sql === 'SELECT 1' ? timedOut : 'answer',
    )
    const connection = createPostgresWorkflowConnection(pool)

    await expect(
      connection.transaction(async (tx) => {
        await tx.query('SELECT 1')
      }),
    ).rejects.toBe(timedOut)
    // No ROLLBACK: it would only queue behind the statement still in flight.
    expect(log).toStrictEqual(['connect', 'BEGIN', 'SELECT 1'])
    expect(releases).toStrictEqual([true])
  })

  test('rolls back and returns a session whose statement the server rejected', async () => {
    const rejected = new Error('duplicate key')
    const { pool, log, releases, sessions } = createPool((sql) =>
      sql === 'SELECT 1' ? rejected : 'answer',
    )
    const connection = createPostgresWorkflowConnection(pool)

    await expect(
      connection.transaction(async (tx) => {
        await tx.query('SELECT 1')
      }),
    ).rejects.toBe(rejected)
    expect(log).toStrictEqual(['connect', 'BEGIN', 'SELECT 1', 'ROLLBACK'])
    expect(releases).toStrictEqual([false])
    expect(sessions[0]!.listenerCount('error')).toBe(0)
  })

  test('recovers in a savepoint from a statement that failed after its answer', async () => {
    const { pool, log, releases } = createPool((sql) =>
      sql === 'SELECT parsed' ? new Error('type parser failed') : 'answer',
    )
    const connection = createPostgresWorkflowConnection(pool)

    await connection.transaction(async (tx) => {
      await expect(
        tx.transaction(async (nested) => {
          await nested.query('SELECT parsed')
        }),
      ).rejects.toThrow('type parser failed')
      await tx.query('INSERT')
    })

    expect(log).toStrictEqual([
      'connect',
      'BEGIN',
      'SAVEPOINT workflow_savepoint_1',
      'SELECT parsed',
      'ROLLBACK TO SAVEPOINT workflow_savepoint_1',
      'RELEASE SAVEPOINT workflow_savepoint_1',
      'INSERT',
      'COMMIT',
    ])
    expect(releases).toStrictEqual([false])
  })
})

// A backend message: type byte, then a length that counts itself.
const backendMessage = (type: string, body: Buffer) => {
  const header = Buffer.alloc(5)
  header.write(type, 0)
  header.writeInt32BE(body.length + 4, 1)
  return Buffer.concat([header, body])
}

test('handles a fatal error that arrives with the session’s checkout', async () => {
  // One packet completes the startup and then kills the session, as a server
  // shutting down right after accepting it does. `pg` handles both messages
  // in one pass, so the session is checked out and failed in the same tick.
  const server = createServer((socket) => {
    socket.on('error', () => {})
    socket.once('data', () => {
      const fields = [
        'SFATAL',
        'VFATAL',
        'C57P01',
        'Mterminating connection due to administrator command',
      ]
      socket.write(
        Buffer.concat([
          backendMessage('R', Buffer.alloc(4)),
          backendMessage('Z', Buffer.from('I')),
          backendMessage(
            'E',
            Buffer.concat([
              ...fields.map((field) => Buffer.from(`${field}\0`)),
              Buffer.from([0]),
            ]),
          ),
        ]),
      )
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  const pool = new pg.Pool({ host: '127.0.0.1', port, user: 'fake', max: 1 })
  try {
    const connection = createPostgresWorkflowConnection(pool)

    await expect(
      connection.transaction(async (tx) => {
        await tx.query('SELECT 1')
      }),
    ).rejects.toThrow('terminating connection')
    expect(pool.totalCount).toBe(0)
  } finally {
    await pool.end()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

describe('statement answer deadline', () => {
  const answerTimeoutMs = 1_000
  const missedDeadline = {
    message: expect.stringContaining('did not answer'),
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const unanswered = (statement: string) => (sql: string) =>
    sql === statement ? 'never' : 'answer'

  test.each([
    ['BEGIN', ['connect', 'BEGIN']],
    ['SELECT 1', ['connect', 'BEGIN', 'SELECT 1']],
    ['COMMIT', ['connect', 'BEGIN', 'SELECT 1', 'COMMIT']],
  ])(
    'fails a transaction whose %s goes unanswered and discards its session',
    async (stage, expectedLog) => {
      const { pool, log, releases } = createPool(unanswered(stage))
      const connection = createPostgresWorkflowConnection(pool, {
        answerTimeoutMs,
      })

      const failed = connection
        .transaction(async (tx) => {
          await tx.query('SELECT 1')
        })
        .catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(answerTimeoutMs)

      expect(await failed).toMatchObject(missedDeadline)
      // No ROLLBACK: it would only queue behind the unanswered statement.
      expect(log).toStrictEqual(expectedLog)
      expect(releases).toStrictEqual([true])
    },
  )

  test('discards the session when the deadline passes, not when the handler ends', async () => {
    const { pool, log, releases } = createPool(unanswered('SELECT 1'))
    const connection = createPostgresWorkflowConnection(pool, {
      answerTimeoutMs,
    })
    const resume = deferred()
    let later: unknown

    const failed = connection
      .transaction(async (tx) => {
        await tx.query('SELECT 1').catch(() => {})
        await resume.promise
        later = await tx.query('SELECT 2').catch((error: unknown) => error)
      })
      .catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(answerTimeoutMs)

    // The handler caught the failure and is still paused.
    expect(releases).toStrictEqual([true])
    resume.resolve()
    expect(await failed).toMatchObject(missedDeadline)
    expect(later).toMatchObject(missedDeadline)
    expect(log).toStrictEqual(['connect', 'BEGIN', 'SELECT 1'])
    expect(releases).toStrictEqual([true])
  })

  test('runs a top-level statement on a session it can discard', async () => {
    const { pool, log, releases } = createPool(unanswered('SELECT 1'))
    const connection = createPostgresWorkflowConnection(pool, {
      answerTimeoutMs,
    })

    const failed = connection.query('SELECT 1').catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(answerTimeoutMs)

    expect(await failed).toMatchObject(missedDeadline)
    expect(log).toStrictEqual(['connect', 'SELECT 1'])
    expect(releases).toStrictEqual([true])
  })

  test.each([
    ['a driver read timeout', readTimeout()],
    ['a server error', new Error('division by zero')],
  ])(
    'discards a top-level session whose statement failed with %s',
    async (_name, failure) => {
      const { pool, releases } = createPool(() => failure)
      const connection = createPostgresWorkflowConnection(pool, {
        answerTimeoutMs,
      })

      await expect(connection.query('SELECT 1')).rejects.toBe(failure)
      expect(releases).toStrictEqual([true])
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  test('discards a top-level session whose socket fails mid-statement', async () => {
    const { pool, log, releases, sessions } = createPool(unanswered('SELECT 1'))
    const connection = createPostgresWorkflowConnection(pool, {
      answerTimeoutMs,
    })
    const lost = new Error('Connection terminated unexpectedly')

    const failed = connection.query('SELECT 1').catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(0)
    expect(log).toStrictEqual(['connect', 'SELECT 1'])
    // Without a listener, this `error` event would throw.
    sessions[0]!.fail(lost)

    expect(await failed).toBe(lost)
    expect(releases).toStrictEqual([true])
    expect(sessions[0]!.listenerCount('error')).toBe(0)
  })

  test('returns answered sessions to the pool with no deadline left armed', async () => {
    const { pool, log, releases } = createPool()
    const connection = createPostgresWorkflowConnection(pool, {
      answerTimeoutMs,
    })

    await connection.query('SELECT 1')
    await connection.transaction(async (tx) => {
      await tx.query('SELECT 2')
    })

    expect(vi.getTimerCount()).toBe(0)
    expect(log).toStrictEqual([
      'connect',
      'SELECT 1',
      'connect',
      'BEGIN',
      'SELECT 2',
      'COMMIT',
    ])
    expect(releases).toStrictEqual([false, false])
  })

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31])(
    'rejects an answer deadline of %s before any work',
    (value) => {
      const { pool, log } = createPool()
      expect(() =>
        createPostgresWorkflowConnection(pool, { answerTimeoutMs: value }),
      ).toThrow(RangeError)
      expect(log).toStrictEqual([])
    },
  )

  const plainClient = { query: async () => ({ rows: [] }) }
  test.each([
    [
      'a transaction-API client',
      { ...plainClient, transaction: async () => undefined as never },
    ],
    ['a plain client', plainClient],
  ] as const)(
    'rejects an answer deadline for %s, whose sessions it cannot discard',
    (_name, client) => {
      expect(() =>
        createPostgresWorkflowConnection(client, { answerTimeoutMs }),
      ).toThrow(TypeError)
    },
  )
})
