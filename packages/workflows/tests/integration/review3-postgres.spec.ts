import { randomUUID } from 'node:crypto'

import pg from 'pg'
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

import {
  createPostgresWorkflowConnection,
  createPostgresWorkflowRuntime,
} from '../../src/adapters/postgres.ts'
import { installPostgresWorkflowSchemaForTesting } from '../../src/adapters/postgres/testing.ts'
import { postgresTarget, requireServiceEnv, wait } from './helpers.ts'

requireServiceEnv(postgresTarget)

describe.skipIf(!postgresTarget.url)('review 3: PostgreSQL adapter', () => {
  // The database is shared and other specs truncate its workflow tables, so
  // these sessions work in a schema of their own. The enum types stay the
  // shared ones, which the installer finds through `public`.
  const schema = `review3_${randomUUID().replaceAll('-', '')}`
  const sessionOptions = (applicationName: string) => ({
    connectionString: postgresTarget.url,
    options: `-c search_path=${schema},public`,
    application_name: applicationName,
  })
  const waiterName = `review3-waiter-${randomUUID()}`
  const closers: (() => Promise<unknown>)[] = []
  let pool!: pg.Pool

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: postgresTarget.url })
    await admin.connect()
    try {
      await admin.query(`CREATE SCHEMA ${schema}`)
    } finally {
      await admin.end()
    }
    pool = new pg.Pool({ ...sessionOptions('review3'), max: 4 })
    const connection = createPostgresWorkflowConnection(pool)
    await installPostgresWorkflowSchemaForTesting(connection)
    await connection.query('CREATE TABLE sample (id integer PRIMARY KEY)')
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.allSettled(closers.splice(0).map((close) => close()))
  })

  afterAll(async () => {
    await pool.end()
    const admin = new pg.Client({ connectionString: postgresTarget.url })
    await admin.connect()
    try {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`)
    } finally {
      await admin.end()
    }
  })

  async function createPlainClient(applicationName = 'review3-plain') {
    const client = new pg.Client(sessionOptions(applicationName))
    await client.connect()
    closers.push(() => client.end())
    return client
  }

  const count = async (table: string, where = 'true') =>
    (
      await pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM ${table} WHERE ${where}`,
      )
    ).rows[0]!.count

  it.each([
    ['a pool', async () => pool],
    ['a plain client', () => createPlainClient()],
  ] as const)(
    'rolls back a run started beside a failing sibling over %s',
    async (_name, createClient) => {
      const connection = createPostgresWorkflowConnection(await createClient())
      const runtime = createPostgresWorkflowRuntime({ connection })
      const workflowName = `review3-leak-${randomUUID()}`
      const sampleId = Math.floor(Math.random() * 2 ** 31)
      let started: Promise<unknown> | undefined

      await expect(
        connection.transaction(async (tx) => {
          await tx.query('INSERT INTO sample (id) VALUES ($1)', [sampleId])
          // The failing scope takes the connection first, so the start is
          // still queued behind it when `Promise.all` rejects.
          const failing = tx.transaction(async () => {
            throw new Error('sibling failed')
          })
          started = runtime.atomicStart!.startWorkflowRun({
            connection: tx,
            run: { workflowName, input: {} },
          })
          await Promise.all([failing, started])
        }),
      ).rejects.toThrow('sibling failed')

      await Promise.allSettled([started])
      await wait(50)
      expect(await count('sample', `id = ${sampleId}`)).toBe(0)
      expect(await count('workflow_runs', `name = '${workflowName}'`)).toBe(0)
    },
  )

  it('keeps wall-clock timestamps and creation order for a burst of runs', async () => {
    const { store } = createPostgresWorkflowRuntime({
      connection: createPostgresWorkflowConnection(pool),
    })
    const name = `review3-burst-${randomUUID()}`
    const fixed = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(fixed)

    const created: string[] = []
    for (let index = 0; index < 100; index++) {
      const run = await store.createRun({
        workflowName: name,
        input: { index },
      })
      expect(run.activeSince).toBe(fixed)
      expect(run.createdAt).toBe(fixed)
      created.push(run.id)
    }

    const listed: string[] = []
    let cursor: string | undefined
    do {
      const page = await store.listRuns({ name, limit: 7, cursor })
      listed.push(...page.runs.map((run) => run.id))
      cursor = page.nextCursor
    } while (cursor)
    expect(listed).toStrictEqual(created.toReversed())
  })

  it('a retry waiting on another session`s uncommitted retry returns that successor', async () => {
    const { store } = createPostgresWorkflowRuntime({
      connection: createPostgresWorkflowConnection(pool),
    })
    const run = await store.createRun({
      workflowName: `review3-after-${randomUUID()}`,
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
    const retry = { ...ref, input: { value: 1 }, after: first.id }

    // Session A retries inside a transaction it keeps open, holding the child
    // row lock with its successor still uncommitted.
    const sessionA = createPostgresWorkflowConnection(
      await createPlainClient('review3-holder'),
    )
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let markCreated!: () => void
    const created = new Promise<void>((resolve) => {
      markCreated = resolve
    })
    const holder = sessionA.transaction(async (tx) => {
      const attempt = await createPostgresWorkflowRuntime({
        connection: tx,
      }).store.createAttempt(retry)
      markCreated()
      await gate
      return attempt
    })
    // Released on any failure below so the holder never outlives the test.
    closers.unshift(async () => {
      release()
      await holder.catch(() => {})
    })
    await created

    const sessionB = await createPlainClient(waiterName)
    let settled = false
    const waiter = createPostgresWorkflowRuntime({
      connection: createPostgresWorkflowConnection(sessionB),
    })
      .store.createAttempt(retry)
      .finally(() => {
        settled = true
      })

    // Proof that B is blocked on A's lock rather than merely slow.
    await vi.waitFor(
      async () => {
        const blocked = await pool.query(
          `SELECT 1 FROM pg_stat_activity
           WHERE application_name = $1 AND wait_event_type = 'Lock'`,
          [waiterName],
        )
        expect(blocked.rows).toHaveLength(1)
      },
      { timeout: 10_000, interval: 50 },
    )
    expect(settled).toBe(false)

    release()
    const second = await holder
    expect(second.id).not.toBe(first.id)
    expect(second.attemptNumber).toBe(2)
    await expect(waiter).resolves.toStrictEqual(second)
    expect(await count('workflow_attempts', `run_id = '${run.id}'`)).toBe(2)
    const snapshot = await store.loadNodeSnapshot(ref)
    expect(snapshot!.children[0]!.currentAttemptId).toBe(second.id)
    expect(snapshot!.children[0]!.attemptCount).toBe(2)
  })
})
