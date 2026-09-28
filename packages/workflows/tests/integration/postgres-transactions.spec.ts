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
  verifyPostgresWorkflowSchema,
  WORKFLOW_POSTGRES_SCHEMA_MANIFEST,
  type WorkflowPostgresConnection,
} from '../../src/adapters/postgres.ts'
import { installPostgresWorkflowSchemaForTesting } from '../../src/adapters/postgres/testing.ts'
import { createWorkflowRuntimeClient } from '../../src/runtime/index.ts'
import {
  createStallingProxy,
  postgresTarget,
  requireServiceEnv,
  type StallingProxy,
  wait,
} from './helpers.ts'

requireServiceEnv(postgresTarget)

describe.skipIf(!postgresTarget.url)(
  '@nmtjs/workflows Postgres transactions and sessions',
  () => {
    // The database is shared and other specs truncate its workflow tables, so
    // these sessions work in a schema of their own.
    const schema = `transactions_${randomUUID().replaceAll('-', '')}`
    const sessionOptions = (applicationName: string) => ({
      connectionString: postgresTarget.url,
      options: `-c search_path=${schema},public`,
      application_name: applicationName,
    })
    const waiterName = `transactions-waiter-${randomUUID()}`
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
      pool = new pg.Pool({ ...sessionOptions('transactions-pool'), max: 4 })
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

    async function createPlainClient(applicationName = 'transactions-plain') {
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

    it('replaces a pooled session after rollback fails without hiding the original error', async () => {
      const isolated = new pg.Pool({
        ...sessionOptions('transactions-failed-rollback'),
        max: 1,
      })
      closers.push(() => isolated.end())
      const original = new Error('handler failed')
      const sampleId = Math.floor(Math.random() * 2 ** 31)
      const before = await isolated.query<{ pid: number }>(
        'SELECT pg_backend_pid() AS pid',
      )
      const wrappedPool = {
        get totalCount() {
          return isolated.totalCount
        },
        query: isolated.query.bind(isolated),
        async connect() {
          const client = await isolated.connect()
          return {
            async query<T extends Record<string, unknown>>(
              sql: string,
              params: readonly unknown[] = [],
            ) {
              // Leave a real transaction open: returning this client to the
              // pool would make the next borrower's writes join it silently.
              if (sql === 'ROLLBACK') throw new Error('rollback failed')
              return client.query<T>(sql, [...params])
            },
            release(destroy?: boolean) {
              client.release(destroy)
            },
          }
        },
      }
      const connection = createPostgresWorkflowConnection(wrappedPool)

      await expect(
        connection.transaction(async (tx) => {
          await tx.query('INSERT INTO sample (id) VALUES ($1)', [sampleId])
          throw original
        }),
      ).rejects.toBe(original)
      expect(isolated.totalCount).toBe(0)

      const after = await isolated.query<{ pid: number }>(
        'SELECT pg_backend_pid() AS pid',
      )
      expect(after.rows[0]!.pid).not.toBe(before.rows[0]!.pid)
      expect(await count('sample', `id = ${sampleId}`)).toBe(0)
      await isolated.query('INSERT INTO sample (id) VALUES ($1)', [sampleId])
      expect(await count('sample', `id = ${sampleId}`)).toBe(1)
    })

    // A one-session pool behind a proxy that can stop forwarding.
    async function createStallingPool(options: pg.PoolConfig = {}) {
      const proxy = await createStallingProxy(postgresTarget.url!)
      closers.push(() => proxy.close())
      const stalling = new pg.Pool({
        ...sessionOptions('transactions-unanswered'),
        connectionString: proxy.url,
        max: 1,
        idleTimeoutMillis: 0,
        ...options,
      })
      closers.push(() => stalling.end())
      const sessions: pg.Client[] = []
      stalling.on('connect', (session) => {
        sessions.push(session as unknown as pg.Client)
      })
      return { proxy, stalling, sessions }
    }

    const pid = async (connection: WorkflowPostgresConnection) =>
      (
        await connection.query<{ pid: number }>(
          'SELECT pg_backend_pid() AS pid',
        )
      ).rows[0]!.pid

    const stallingRuns = [
      [
        'a transaction',
        (
          connection: WorkflowPostgresConnection,
          proxy: StallingProxy,
          sampleId: number,
        ) =>
          connection.transaction(async (tx) => {
            await tx.query('INSERT INTO sample (id) VALUES ($1)', [sampleId])
            proxy.stall()
            await tx.query('SELECT 1')
          }),
      ],
      [
        'a top-level statement',
        (connection: WorkflowPostgresConnection, proxy: StallingProxy) => {
          proxy.stall()
          return connection.query('SELECT 1')
        },
      ],
    ] as const

    const answerDeadline = {
      bound: 'the answer deadline',
      poolOptions: {},
      connectionOptions: { answerTimeoutMs: 1_000 },
      message: 'did not answer',
    }
    // The driver's read timeout fails the statement first but leaves it in
    // flight on the session.
    const driverTimeout = {
      bound: "the driver's earlier read timeout",
      poolOptions: { query_timeout: 1_000 },
      connectionOptions: { answerTimeoutMs: 60_000 },
      message: 'Query read timeout',
    }

    it.each(
      stallingRuns.flatMap(([name, run]) =>
        [answerDeadline, driverTimeout].map(
          (bound) => [name, bound.bound, run, bound] as const,
        ),
      ),
    )(
      'fails %s the server stops answering at %s and discards its session',
      async (
        _name,
        _bound,
        run,
        { poolOptions, connectionOptions, message },
      ) => {
        const sampleId = Math.floor(Math.random() * 2 ** 31)
        const { proxy, stalling, sessions } =
          await createStallingPool(poolOptions)
        const connection = createPostgresWorkflowConnection(
          stalling,
          connectionOptions,
        )

        // Only the deadlines' timers, faked for every statement of the test:
        // the sockets stay real, and a healthy statement cannot miss a
        // deadline that time reaches only once the proxy dropped one.
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        try {
          const before = await pid(connection)
          const failed = run(connection, proxy, sampleId).catch(
            (error: unknown) => error,
          )
          await proxy.swallowed
          await vi.advanceTimersByTimeAsync(1_000)
          expect(await failed).toMatchObject({
            message: expect.stringContaining(message),
          })

          expect(sessions).toHaveLength(1)
          expect(sessions[0]!.connection.stream.destroyed).toBe(true)
          expect(stalling.totalCount).toBe(0)
          expect(await pid(connection)).not.toBe(before)
        } finally {
          vi.useRealTimers()
        }
        expect(await count('sample', `id = ${sampleId}`)).toBe(0)
      },
    )

    it.each([
      ['without', {}],
      ['with', { answerTimeoutMs: 60_000 }],
    ] as const)(
      'recovers in a savepoint from a type parser that threw, %s an answer deadline',
      async (_name, connectionOptions) => {
        const [first, second] = [0, 1].map(() =>
          Math.floor(Math.random() * 2 ** 31),
        )
        // `pg` rejects the statement only after its ReadyForQuery, so the
        // session is in sync and its transaction can go on.
        const parsing = new pg.Pool({
          ...sessionOptions('transactions-type-parser'),
          max: 1,
          types: {
            getTypeParser: ((oid: number, format?: 'text' | 'binary') =>
              oid === pg.types.builtins.NUMERIC
                ? () => {
                    throw new Error('numeric parser failed')
                  }
                : pg.types.getTypeParser(oid, format)) as never,
          },
        })
        closers.push(() => parsing.end())
        const connection = createPostgresWorkflowConnection(
          parsing,
          connectionOptions,
        )

        await connection.transaction(async (tx) => {
          await tx.query('INSERT INTO sample (id) VALUES ($1)', [first])
          await expect(
            tx.transaction(async (nested) => {
              await nested.query('SELECT 1.5::numeric AS value')
            }),
          ).rejects.toThrow('numeric parser failed')
          await tx.query('INSERT INTO sample (id) VALUES ($1)', [second])
        })

        expect(await count('sample', `id IN (${first}, ${second})`)).toBe(2)
      },
    )

    it('discards a pooled session whose socket fails mid-transaction', async () => {
      const sampleId = Math.floor(Math.random() * 2 ** 31)
      const { proxy, stalling, sessions } = await createStallingPool()
      const connection = createPostgresWorkflowConnection(stalling)

      const failed = connection
        .transaction(async (tx) => {
          await tx.query('INSERT INTO sample (id) VALUES ($1)', [sampleId])
          proxy.stall()
          await tx.query('SELECT 1')
        })
        .catch((error: unknown) => error)
      await proxy.swallowed
      // The checked-out client reports the lost socket as an `error` event,
      // which would crash the process with nobody listening.
      await proxy.close()

      expect(await failed).toMatchObject({
        message: expect.stringContaining('Connection terminated'),
      })
      expect(sessions).toHaveLength(1)
      expect(sessions[0]!.connection.stream.destroyed).toBe(true)
      expect(stalling.totalCount).toBe(0)
      expect(await count('sample', `id = ${sampleId}`)).toBe(0)
    })

    it("bounds dead-command pruning while skipping another session's locked row", async () => {
      const connection = createPostgresWorkflowConnection(pool)
      const runtime = createPostgresWorkflowRuntime({ connection })
      const client = createWorkflowRuntimeClient(runtime)
      const run = await runtime.store.createRun({
        workflowName: 'prune-locked-commands',
        input: {},
      })
      const ids = [randomUUID(), randomUUID(), randomUUID()].sort()
      await pool.query(
        `INSERT INTO workflow_commands (id, kind, run_id, dead_at, reaped_at)
         SELECT id, 'activity', $1, '2020-01-01'::timestamptz, '2020-01-01'::timestamptz
         FROM unnest($2::uuid[]) AS id`,
        [run.id, ids],
      )
      const params = {
        olderThan: Date.parse('2020-01-02T00:00:00Z'),
        statuses: [],
        batchSize: 1,
      }
      const holder = await pool.connect()
      try {
        await holder.query('BEGIN')
        await holder.query(
          'SELECT id FROM workflow_commands WHERE id = $1 FOR UPDATE',
          [ids[0]],
        )
        await expect(
          connection.transaction(async (tx) => {
            // A missing SKIP LOCKED must fail, rather than hang the test.
            await tx.query("SET LOCAL statement_timeout = '2s'")
            const scoped = createPostgresWorkflowRuntime({ connection: tx })
            return scoped.retentionPruner!.pruneTerminalRuns(params)
          }),
        ).resolves.toStrictEqual({ deleted: 0, hasMore: true })
        const remaining = await pool.query<{ id: string }>(
          'SELECT id FROM workflow_commands WHERE run_id = $1 ORDER BY id',
          [run.id],
        )
        expect(remaining.rows.map(({ id }) => id)).toEqual([ids[0], ids[2]])

        // The client drains unlocked commands, then stops when only locked work remains.
        await expect(client.pruneRuns(params)).resolves.toStrictEqual({
          deleted: 0,
        })
        const locked = await pool.query<{ id: string }>(
          'SELECT id FROM workflow_commands WHERE run_id = $1',
          [run.id],
        )
        expect(locked.rows).toEqual([{ id: ids[0] }])
      } finally {
        await holder.query('ROLLBACK')
        holder.release()
      }

      await client.pruneRuns(params)
      const remaining = await pool.query<{ id: string }>(
        'SELECT id FROM workflow_commands WHERE run_id = $1',
        [run.id],
      )
      expect(remaining.rows).toEqual([])
    })

    it('has the foreign keys and the claim index in its own schema', async () => {
      // The shared `public` schema holds the same names, which the installer
      // once took for this schema's: the specs here then ran without them.
      const foreignKeys = await pool.query<{ name: string }>(
        `
          SELECT c.conname AS name
          FROM pg_constraint c
          JOIN pg_class rel ON rel.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = rel.relnamespace
          WHERE n.nspname = $1 AND c.contype = 'f'
        `,
        [schema],
      )
      expect(foreignKeys.rows.map((row) => row.name).sort()).toStrictEqual(
        WORKFLOW_POSTGRES_SCHEMA_MANIFEST.constraints
          .filter((name) => name.endsWith('_fk'))
          .sort(),
      )
      const claimIndex = await pool.query<{ predicate: string | null }>(
        `
          SELECT pg_get_expr(i.indpred, i.indrelid) AS predicate
          FROM pg_index i
          JOIN pg_class c ON c.oid = i.indexrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relname = 'workflow_commands_claim_idx'
        `,
        [schema],
      )
      expect(claimIndex.rows).toStrictEqual([
        { predicate: '(dead_at IS NULL)' },
      ])
      await expect(
        verifyPostgresWorkflowSchema(createPostgresWorkflowConnection(pool)),
      ).resolves.toBeUndefined()
    })

    it.each([
      ['a pool', async () => pool],
      ['a plain client', () => createPlainClient()],
    ] as const)(
      'rolls back a run started beside a failing sibling over %s',
      async (_name, createClient) => {
        const connection = createPostgresWorkflowConnection(
          await createClient(),
        )
        const runtime = createPostgresWorkflowRuntime({ connection })
        const workflowName = `transactions-leak-${randomUUID()}`
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
      const name = `transactions-burst-${randomUUID()}`
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
        workflowName: `transactions-after-${randomUUID()}`,
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
        await createPlainClient('transactions-holder'),
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
  },
)
