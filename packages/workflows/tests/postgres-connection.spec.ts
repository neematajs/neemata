import { PGlite } from '@electric-sql/pglite'
import { expect, test } from 'vitest'

import {
  createPostgresWorkflowConnection,
  type WorkflowPostgresQueryResult,
} from '../src/adapters/postgres.ts'

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
