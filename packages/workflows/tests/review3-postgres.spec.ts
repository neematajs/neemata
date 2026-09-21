import { PGlite } from '@electric-sql/pglite'
import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  createPostgresWorkflowConnection,
  createPostgresWorkflowRuntime,
  type WorkflowPostgresConnection,
} from '../src/adapters/postgres.ts'
import { installPostgresWorkflowSchemaForTesting } from '../src/adapters/postgres/testing.ts'

type Row = Record<string, unknown>

// The shape of a single `pg.Client`: one session, no transaction API.
const createPlainClient = (db: PGlite) => ({
  query: <T extends Row = Row>(sql: string, params: readonly unknown[] = []) =>
    db.query<T>(sql, [...params]),
})

const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

const count = async (connection: WorkflowPostgresConnection, table: string) =>
  (
    await connection.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM ${table}`,
    )
  ).rows[0]!.count

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
          run: { workflowName: 'review3-leak', input: {} },
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

describe('run timestamps', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('a burst of runs keeps wall-clock timestamps and its creation order', async () => {
    const connection = createPostgresWorkflowConnection(new PGlite())
    await installPostgresWorkflowSchemaForTesting(connection)
    const { store } = createPostgresWorkflowRuntime({ connection })
    const fixed = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(fixed)

    const created: string[] = []
    for (let index = 0; index < 100; index++) {
      const run = await store.createRun({
        workflowName: 'review3-burst',
        input: { index },
      })
      expect(run.activeSince).toBe(fixed)
      expect(run.createdAt).toBe(fixed)
      expect(run.updatedAt).toBe(fixed)
      created.push(run.id)
    }

    // A timeout sweep one millisecond later sees every run as due.
    const due = await store.listRuns({
      name: 'review3-burst',
      activeBefore: fixed + 1,
    })
    expect(due.runs).toHaveLength(100)

    const newestFirst = created.toReversed()
    const listed: string[] = []
    const summarized: string[] = []
    let cursor: string | undefined
    do {
      const page = await store.listRuns({
        name: 'review3-burst',
        limit: 7,
        cursor,
      })
      const summaries = await store.listRunSummaries({
        name: 'review3-burst',
        limit: 7,
        cursor,
      })
      listed.push(...page.runs.map((run) => run.id))
      summarized.push(...summaries.runs.map((run) => run.id))
      cursor = page.nextCursor
    } while (cursor)
    expect(listed).toStrictEqual(newestFirst)
    expect(summarized).toStrictEqual(newestFirst)
  })
})
