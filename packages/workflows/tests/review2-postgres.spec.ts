import { PGlite } from '@electric-sql/pglite'
import { describe, expect, test } from 'vitest'
import * as z from 'zod'

import {
  createPostgresWorkflowConnection,
  createPostgresWorkflowRuntime,
  type WorkflowPostgresConnection,
} from '../src/adapters/postgres.ts'
import { installPostgresWorkflowSchemaForTesting } from '../src/adapters/postgres/testing.ts'
import { defineWorkflow, implementWorkflow } from '../src/index.ts'
import {
  createWorkflowRuntimeClient,
  runExecutionWorker,
  runWorkflowWorker,
} from '../src/runtime/index.ts'

type Row = Record<string, unknown>

// The shape of a single `pg.Client`: one session, no transaction API.
const createPlainClient = (db: PGlite) => ({
  query: <T extends Row = Row>(sql: string, params: readonly unknown[] = []) =>
    db.query<T>(sql, [...params]),
})

async function createRuntime(maxDeliveries?: number) {
  const connection = createPostgresWorkflowConnection(new PGlite())
  await installPostgresWorkflowSchemaForTesting(connection)
  const runtime = createPostgresWorkflowRuntime({ connection, maxDeliveries })
  return { connection, runtime }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

describe('createAttempt `after`', () => {
  async function failedFirstAttempt() {
    const { connection, runtime } = await createRuntime()
    const { store } = runtime
    const run = await store.createRun({
      workflowName: 'review2-after',
      input: {},
    })
    const ref = { runId: run.id, nodeName: 'content', childKey: '$self' }
    await store.createNode({
      runId: run.id,
      name: ref.nodeName,
      kind: 'activity',
    })
    await store.ensureNodeChildren({
      ...ref,
      children: [{ childKey: ref.childKey, kind: 'activity' }],
    })
    const { attempt: first } = await store.ensureChildAttempt({
      ...ref,
      input: { value: 1 },
    })
    await store.failCurrentAttempt({
      attemptId: first.id,
      leaseToken: first.leaseToken!,
      error: new Error('boom'),
    })
    const attemptCount = async () =>
      (
        await connection.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM workflow_attempts',
        )
      ).rows[0]!.count
    return { store, ref, first, attemptCount }
  }

  test('creates the retry while `after` is still current, then hands back the successor', async () => {
    const { store, ref, first, attemptCount } = await failedFirstAttempt()
    const retry = { ...ref, input: { value: 1 }, after: first.id }

    const second = await store.createAttempt(retry)
    expect(second.id).not.toBe(first.id)
    expect(second.attemptNumber).toBe(2)
    expect(second.retryAttemptNumber).toBe(2)

    const replayed = await store.createAttempt(retry)
    expect(replayed).toStrictEqual(second)
    expect(await attemptCount()).toBe(2)
    const snapshot = await store.loadNodeSnapshot(ref)
    expect(snapshot!.children[0]!.currentAttemptId).toBe(second.id)
    expect(snapshot!.children[0]!.attemptCount).toBe(2)

    // Without `after` the call still supersedes, as before.
    const third = await store.createAttempt({ ...ref, input: { value: 1 } })
    expect(third.attemptNumber).toBe(3)
  })

  test('two concurrent retries of one failure share one successor', async () => {
    const { store, ref, first, attemptCount } = await failedFirstAttempt()
    const retry = { ...ref, input: { value: 1 }, after: first.id }

    const [left, right] = await Promise.all([
      store.createAttempt(retry),
      store.createAttempt(retry),
    ])
    expect(left.id).not.toBe(first.id)
    expect(right).toStrictEqual(left)
    expect(await attemptCount()).toBe(2)
  })

  test('a terminal child still rejects a retry', async () => {
    const { store, ref, first } = await failedFirstAttempt()
    await store.failNodeChild({ ...ref, error: new Error('exhausted') })

    await expect(
      store.createAttempt({ ...ref, input: { value: 1 }, after: first.id }),
    ).rejects.toThrow('Terminal node child')
  })
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

describe('run lists', () => {
  test('an empty status selection matches nothing', async () => {
    const { connection, runtime } = await createRuntime()
    await runtime.store.createRun({ workflowName: 'review2-list', input: {} })
    const client = createWorkflowRuntimeClient(runtime)
    let queries = 0
    const counted = createPostgresWorkflowRuntime({
      connection: {
        query: (sql, params) => {
          queries++
          return connection.query(sql, params)
        },
        transaction: (handler) => connection.transaction(handler),
      },
    })

    expect(await client.list({ status: [] })).toStrictEqual({ runs: [] })
    expect(await client.listSummaries({ status: [] })).toStrictEqual({
      runs: [],
    })
    await counted.store.listRuns({ status: [] })
    await counted.store.listRunSummaries({ status: [] })
    expect(queries).toBe(0)

    expect((await client.list({ status: ['queued'] })).runs).toHaveLength(1)
    expect((await client.list({ status: 'queued' })).runs).toHaveLength(1)
    expect((await client.list({ tags: {}, input: {} })).runs).toHaveLength(1)
  })
})

describe('child workflow cancellation policy', () => {
  const text = z.string()
  const child = defineWorkflow({
    name: 'review2.detach.child',
    input: text,
    output: text,
  })
    .activity('work', { input: text, output: text })
    .build()
  const childImplementation = implementWorkflow(child, { pool: 'test' })
    .work(async (input) => `${input}!`)
    .finish(({ work }) => work)
  const parent = defineWorkflow({
    name: 'review2.detach.parent',
    input: text,
    output: text,
  })
    .workflow('sub', child, { cancellation: 'detach' })
    .build()
  const parentImplementation = implementWorkflow(parent, { pool: 'test' })
    .sub(child)
    .finish(() => 'done')

  test('run detail reports a stored detach policy', async () => {
    const { runtime } = await createRuntime()
    const { store } = runtime
    const run = await store.createRun({
      workflowName: 'review2-detail',
      input: {},
    })
    const ref = { runId: run.id, nodeName: 'sub', childKey: '$self' }
    await store.createNode({
      runId: run.id,
      name: ref.nodeName,
      kind: 'workflow',
    })
    await store.ensureNodeChildren({
      ...ref,
      children: [{ childKey: ref.childKey, kind: 'workflow' }],
    })
    await store.ensureChildRun({
      ...ref,
      childKind: 'workflow',
      childName: 'review2-detail-child',
      input: {},
      rootRunId: run.id,
      cancellation: 'detach',
    })

    const client = createWorkflowRuntimeClient(runtime)
    expect((await client.get(run.id))!.children[0]!.cancellation).toBe('detach')
    expect((await client.getDetail(run.id))!.children[0]!.cancellation).toBe(
      'detach',
    )
  })

  test('a detached child outlives its cancelled parent and completes', async () => {
    const { connection, runtime } = await createRuntime(1)
    const client = createWorkflowRuntimeClient(runtime)
    const workers = {
      ...runtime,
      workflows: [parentImplementation, childImplementation],
      tasks: [],
      workerId: 'review2',
    }
    const run = await client.start(parent, 'hi')
    // Parks the parent on its child; the child stays live on its unclaimed activity.
    await runWorkflowWorker(workers)
    const edge = (await client.get(run.id))!.children[0]!
    expect(edge.cancellation).toBe('detach')
    expect((await client.get(edge.childRunId!))!.run.status).toBe('running')

    await client.cancel(run.id)
    await runWorkflowWorker(workers)
    expect((await client.get(run.id))!.run.status).toBe('cancelled')
    expect((await client.get(edge.childRunId!))!.run.status).toBe('running')

    // The child finishes and wakes a parent that is already terminal.
    for (let round = 0; round < 4; round++) {
      await runWorkflowWorker(workers)
      await runExecutionWorker(workers)
    }
    const finished = (await client.get(edge.childRunId!))!
    expect(finished.run.status).toBe('completed')
    expect(finished.run.output).toBe('hi!')
    expect((await client.get(run.id))!.run.status).toBe('cancelled')
    expect(await runtime.store.listDeadCommands()).toHaveLength(0)
    const pending = await connection.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM workflow_commands',
    )
    expect(pending.rows[0]!.count).toBe(0)
  })
})
