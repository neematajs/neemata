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
import * as z from 'zod'

import type { AnyWorkflowDefinition } from '../../src/index.ts'
import type { WorkflowRuntimeAdapter } from '../../src/runtime/index.ts'
import {
  createPostgresWorkflowConnection,
  createPostgresWorkflowRuntime,
  verifyPostgresWorkflowSchema,
  type WorkflowPostgresConnection,
} from '../../src/adapters/postgres.ts'
import { installPostgresWorkflowSchemaForTesting } from '../../src/adapters/postgres/testing.ts'
import {
  defineSchedule,
  defineTask,
  defineWorkflow,
  implementTask,
  implementWorkflow,
} from '../../src/index.ts'
import {
  childRunDefinitionInput,
  describeDefinition,
  runDefinitionInput,
} from '../../src/runtime/definition.ts'
import {
  createWorkflowRuntimeClient,
  runExecutionWorker,
  runWorkflowWorker,
  WorkflowDefinitionConflictError,
  WorkflowIdempotencyConflictError,
  WorkflowRunConflictError,
} from '../../src/runtime/index.ts'
import { postgresTarget, requireServiceEnv } from './helpers.ts'

requireServiceEnv(postgresTarget)

const text = z.string()
const quiet = { reaping: false, runTimeouts: false } as const

function unique(label: string) {
  return `pgi.${label}.${randomUUID().slice(0, 8)}`
}

/**
 * One deployed generation of a task and a workflow that runs an activity and
 * then the task. Handlers stamp their revision, so an output proves which code
 * ran.
 */
function deploy(prefix: string, revision?: string) {
  const tag = revision ?? 'legacy'
  const task = defineTask({
    name: `${prefix}.task`,
    revision,
    input: text,
    output: text,
  })
  const taskImplementation = implementTask(task, {
    pool: 'test',
    handler: async (input) => `${input}|task@${tag}`,
  })
  const flow = defineWorkflow({
    name: `${prefix}.flow`,
    revision,
    input: text,
    output: text,
  })
    .activity('step', { input: text, output: text })
    .task('work', task)
    .build()
  const implementation = implementWorkflow(flow, { pool: 'test' })
    .step(async (input) => `${input}|step@${tag}`)
    .work(task, { input: ({ step }) => step })
    .finish(({ work }) => work)

  return {
    task,
    flow,
    workflows: [implementation],
    tasks: [taskImplementation],
  }
}

/** The workflow of `deploy` under the same name and revision, edited in place. */
function reshape(prefix: string, revision?: string) {
  return defineWorkflow({
    name: `${prefix}.flow`,
    revision,
    input: text,
    output: text,
  })
    .activity('step', { input: text, output: text })
    .build()
}

type Served = Pick<ReturnType<typeof deploy>, 'workflows' | 'tasks'>

/** Runs both worker roles until neither finds work. */
async function drain(runtime: WorkflowRuntimeAdapter, served: Served) {
  for (let pass = 0; pass < 200; pass++) {
    const coordination = await runWorkflowWorker({
      ...runtime,
      ...quiet,
      workflows: served.workflows,
      workerId: `coordinator-${randomUUID()}`,
    })
    const execution = await runExecutionWorker({
      ...runtime,
      reaping: false,
      workflows: served.workflows,
      tasks: served.tasks,
      workerId: `execution-${randomUUID()}`,
    })
    if (coordination.processed + execution.processed === 0) return
  }
  throw new Error('Workers did not settle')
}

describe.skipIf(!postgresTarget.url)(
  '@nmtjs/workflows Postgres execution revisions under concurrency',
  () => {
    // The database is shared and other specs truncate its workflow tables, and
    // saved revisions outlive every run: these sessions get a schema of their
    // own, dropped afterwards.
    const schema = `revisions_${randomUUID().replaceAll('-', '')}`
    const waiterName = `revisions-waiter-${randomUUID()}`
    function sessionOptions(applicationName: string) {
      return {
        connectionString: postgresTarget.url,
        options: `-c search_path=${schema},public`,
        application_name: applicationName,
      }
    }
    const closers: (() => Promise<unknown>)[] = []
    let pool!: pg.Pool
    let connection!: WorkflowPostgresConnection

    async function withAdmin(run: (admin: pg.Client) => Promise<unknown>) {
      const admin = new pg.Client({ connectionString: postgresTarget.url })
      await admin.connect()
      try {
        await run(admin)
      } finally {
        await admin.end()
      }
    }

    beforeAll(async () => {
      await withAdmin((admin) => admin.query(`CREATE SCHEMA ${schema}`))
      pool = new pg.Pool({ ...sessionOptions('revisions-pool'), max: 12 })
      connection = createPostgresWorkflowConnection(pool)
      await installPostgresWorkflowSchemaForTesting(connection)
    })

    afterEach(async () => {
      await Promise.allSettled(closers.splice(0).map((close) => close()))
    })

    afterAll(async () => {
      await pool.end()
      await withAdmin((admin) => admin.query(`DROP SCHEMA ${schema} CASCADE`))
    })

    function createRuntime(db = connection) {
      return createPostgresWorkflowRuntime({ connection: db })
    }

    /** A runtime whose sessions can be found in `pg_stat_activity`. */
    function createWaiter() {
      const waiterPool = new pg.Pool({ ...sessionOptions(waiterName), max: 2 })
      closers.push(() => waiterPool.end())
      return createRuntime(createPostgresWorkflowConnection(waiterPool))
    }

    async function waitUntilBlocked() {
      await vi.waitFor(
        async () => {
          const blocked = await pool.query(
            `SELECT 1 FROM pg_stat_activity
             WHERE application_name = $1 AND wait_event_type = 'Lock'`,
            [waiterName],
          )
          expect(blocked.rows).toHaveLength(1)
        },
        { timeout: 10_000, interval: 25 },
      )
    }

    async function count(table: string, where: string, params: unknown[]) {
      const { rows } = await pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM ${table} WHERE ${where}`,
        params,
      )
      return rows[0]!.count
    }

    function countRuns(prefix: string) {
      return count('workflow_runs', 'name LIKE $1', [`${prefix}.%`])
    }

    function countRevisions(prefix: string) {
      return count('workflow_revisions', 'name LIKE $1', [`${prefix}.%`])
    }

    function createInput(flow: AnyWorkflowDefinition) {
      return {
        workflowName: flow.name,
        input: 'x',
        ...runDefinitionInput(flow),
      }
    }

    /** Holds a transaction open after `work`, until the returned gate opens. */
    function holdTransaction<T>(
      work: (tx: WorkflowPostgresConnection) => Promise<T>,
      outcome: 'commit' | 'rollback',
    ) {
      const rollback = new Error('holder rolled back')
      let open!: () => void
      const gate = new Promise<void>((resolve) => {
        open = resolve
      })
      let started!: (value: T) => void
      const worked = new Promise<T>((resolve) => {
        started = resolve
      })
      const settled = connection
        .transaction(async (tx) => {
          started(await work(tx))
          await gate
          if (outcome === 'rollback') throw rollback
        })
        .catch((error: unknown) => {
          if (error !== rollback) throw error
        })
      return { worked, open, settled }
    }

    it('verifies the schema it installed', async () => {
      await expect(
        verifyPostgresWorkflowSchema(connection),
      ).resolves.toBeUndefined()
    })

    it('lets every concurrent start of one new revision win', async () => {
      const prefix = unique('equal')
      const v1 = deploy(prefix, 'v1')
      const client = createWorkflowRuntimeClient(createRuntime())

      const runs = await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          client.start(v1.flow, `x${index}`),
        ),
      )

      expect(new Set(runs.map(({ id }) => id)).size).toBe(10)
      for (const run of runs) expect(run.executionRevision).toBe('v1')
      expect(await countRuns(prefix)).toBe(10)
      expect(await countRevisions(prefix)).toBe(2)
    })

    it('refuses another manifest once a concurrent start commits the revision', async () => {
      const prefix = unique('blocked')
      const v1 = deploy(prefix, 'v1')
      const edited = reshape(prefix, 'v1')
      const holder = holdTransaction(
        (tx) =>
          createRuntime().atomicStart!.startWorkflowRun({
            run: createInput(v1.flow),
            connection: tx,
          }),
        'commit',
      )
      const winner = await holder.worked

      // The loser sees no saved revision, saves its own graph and then waits
      // on the winner's uncommitted revision row.
      const loser = createWaiter()
        .atomicStart!.startWorkflowRun({ run: createInput(edited) })
        .catch((error: unknown) => error)
      await waitUntilBlocked()
      holder.open()
      await holder.settled

      expect(await loser).toBeInstanceOf(WorkflowDefinitionConflictError)
      // One run, pinned to the manifest that won; the loser's graph went with
      // its transaction.
      const runs = await createRuntime().store.listRuns({ name: v1.flow.name })
      expect(runs.runs.map(({ id }) => id)).toStrictEqual([winner.id])
      expect(runs.runs[0]?.graphHash).toBe(
        describeDefinition(v1.flow).graphHash,
      )
      expect(
        await count('workflow_graphs', 'graph_hash = $1', [
          describeDefinition(edited).graphHash,
        ]),
      ).toBe(0)
      expect(await count('workflow_commands', 'run_id = $1', [winner.id])).toBe(
        1,
      )
    })

    it('saves the waiting manifest when the concurrent start rolls back', async () => {
      const prefix = unique('unblocked')
      const v1 = deploy(prefix, 'v1')
      const edited = reshape(prefix, 'v1')
      const holder = holdTransaction(
        (tx) =>
          createRuntime().atomicStart!.startWorkflowRun({
            run: createInput(v1.flow),
            connection: tx,
          }),
        'rollback',
      )
      await holder.worked

      const waiting = createWaiter().atomicStart!.startWorkflowRun({
        run: createInput(edited),
      })
      await waitUntilBlocked()
      holder.open()
      await holder.settled

      const run = await waiting
      expect(run.graphHash).toBe(describeDefinition(edited).graphHash)
      expect(await countRuns(prefix)).toBe(1)
      expect(
        await createRuntime().store.loadRevision({
          kind: 'workflow',
          name: edited.name,
          revision: 'v1',
        }),
      ).toStrictEqual(describeDefinition(edited).manifest)
    })

    it('lets exactly one of two racing manifests of a revision create a run', async () => {
      const client = createWorkflowRuntimeClient(createRuntime())

      for (let round = 0; round < 15; round++) {
        const prefix = unique('race')
        const candidates = [deploy(prefix, 'v1').flow, reshape(prefix, 'v1')]

        const results = await Promise.allSettled(
          candidates.map((flow) => client.start(flow, 'x')),
        )

        const winners = results.filter(({ status }) => status === 'fulfilled')
        expect(winners).toHaveLength(1)
        for (const [index, result] of results.entries()) {
          if (result.status === 'rejected') {
            expect(result.reason).toBeInstanceOf(
              WorkflowDefinitionConflictError,
            )
            continue
          }
          // The saved manifest is the winner's, and the only run names it.
          const { graphHash, manifest } = describeDefinition(candidates[index]!)
          expect(result.value.graphHash).toBe(graphHash)
          expect(
            await createRuntime().store.loadRevision({
              kind: 'workflow',
              name: candidates[index]!.name,
              revision: 'v1',
            }),
          ).toStrictEqual(manifest)
        }
        expect(await countRuns(prefix)).toBe(1)
      }
    })

    it('gives one idempotency key to one revision and reports its run to the other', async () => {
      const client = createWorkflowRuntimeClient(createRuntime())

      for (let round = 0; round < 15; round++) {
        const prefix = unique('idem')
        const idempotencyKey = [prefix]
        const flows = [deploy(prefix, 'v1').flow, deploy(prefix, 'v2').flow]

        const results = await Promise.allSettled([
          ...flows.map((flow) => client.start(flow, 'x', { idempotencyKey })),
          // A second start of v1 replays whichever run v1 gets, or conflicts.
          client.start(flows[0]!, 'x', { idempotencyKey }),
        ])

        const ids = new Set<string>()
        for (const result of results) {
          if (result.status === 'fulfilled') ids.add(result.value.id)
        }
        expect(ids.size).toBe(1)
        const [runId] = Array.from(ids)
        for (const result of results) {
          if (result.status === 'fulfilled') continue
          expect(result.reason).toBeInstanceOf(WorkflowIdempotencyConflictError)
          expect(result.reason).toMatchObject({ runId })
        }
        expect(await countRuns(prefix)).toBe(1)
        expect(await count('workflow_commands', 'run_id = $1', [runId])).toBe(1)
      }
    })

    it('joins a unique key within one revision and names the holder to another', async () => {
      const runtime = createRuntime()

      for (let round = 0; round < 15; round++) {
        const prefix = unique('join')
        const join = {
          key: [prefix],
          scope: 'active',
          behavior: 'join',
        } as const
        const flows = [
          deploy(prefix, 'v1').flow,
          deploy(prefix, 'v2').flow,
          deploy(prefix, 'v1').flow,
        ]

        const results = await Promise.allSettled(
          flows.map((flow) =>
            runtime.atomicStart!.startWorkflowRun({
              run: { ...createInput(flow), unique: join },
            }),
          ),
        )

        const holders = new Map<string, string | undefined>()
        for (const result of results) {
          if (result.status !== 'fulfilled') continue
          holders.set(result.value.id, result.value.executionRevision)
        }
        expect(holders.size).toBe(1)
        const [[runId, revision]] = Array.from(holders)
        for (const [index, result] of results.entries()) {
          if (result.status === 'fulfilled') {
            expect(flows[index]!.revision).toBe(revision)
            continue
          }
          expect(result.reason).toBeInstanceOf(WorkflowRunConflictError)
          expect(result.reason).toMatchObject({
            runId,
            holder: { kind: 'workflow', name: `${prefix}.flow`, revision },
          })
          expect(flows[index]!.revision).not.toBe(revision)
        }
        expect(await countRuns(prefix)).toBe(1)
        expect(await count('workflow_commands', 'run_id = $1', [runId])).toBe(1)
      }
    })

    it('links one child run when two fenced coordinators race to create it', async () => {
      const runtime = createRuntime()
      const client = createWorkflowRuntimeClient(runtime)

      for (let round = 0; round < 10; round++) {
        const prefix = unique('child')
        const child = defineWorkflow({
          name: `${prefix}.child`,
          revision: 'v1',
          input: text,
          output: text,
        })
          .activity('step', { input: text, output: text })
          .build()
        const parent = defineWorkflow({
          name: `${prefix}.parent`,
          revision: 'v1',
          input: text,
          output: text,
        })
          .workflow('child', child)
          .build()
        const run = await client.start(parent, 'x')
        const nodeName = 'child'
        const childKey = '$self'
        await runtime.store.createNode({
          runId: run.id,
          name: nodeName,
          kind: 'workflow',
        })
        await runtime.store.ensureNodeChildren({
          runId: run.id,
          nodeName,
          children: [{ childKey, kind: 'workflow' }],
        })
        const lease = (await runtime.store.acquireRunLease({
          runId: run.id,
          leaseMs: 30_000,
        }))!
        const params = {
          runId: run.id,
          nodeName,
          childKey,
          childKind: 'workflow' as const,
          childName: child.name,
          input: 'x',
          rootRunId: run.rootRunId,
          ...childRunDefinitionInput(run, child),
          fence: { runLease: lease },
        }

        const [left, right] = await Promise.all([
          runtime.store.ensureChildRun(params),
          createRuntime().store.ensureChildRun(params),
        ])

        expect(left.childRun.id).toBe(right.childRun.id)
        expect(left.created).not.toBe(right.created)
        expect(left.childRun.executionRevision).toBe('v1')
        expect(await countRuns(prefix)).toBe(2)
        const { children } = await runtime.store.loadNodeChildren({
          runId: run.id,
          nodeName,
        })
        expect(children).toMatchObject([{ childRunId: left.childRun.id }])
      }
    })

    it('shows a caller nothing until it commits, and nothing at all if it rolls back', async () => {
      const client = createWorkflowRuntimeClient(createRuntime())
      const committed = unique('commit')
      const discarded = unique('discard')
      const rollback = new Error('caller rolled back')

      await connection.transaction(async (tx) => {
        const run = await client.start(deploy(committed, 'v1').flow, 'x', {
          connection: tx,
        })
        expect(run.executionRevision).toBe('v1')
        // Another session sees neither the run nor what it would point at.
        expect(await countRuns(committed)).toBe(0)
        expect(await countRevisions(committed)).toBe(0)
      })
      expect(await countRuns(committed)).toBe(1)
      expect(await countRevisions(committed)).toBe(2)

      await expect(
        connection.transaction(async (tx) => {
          await client.start(deploy(discarded, 'v1').flow, 'x', {
            connection: tx,
          })
          await client.start(deploy(discarded, 'v1').task, 'x', {
            connection: tx,
          })
          throw rollback
        }),
      ).rejects.toBe(rollback)
      expect(await countRuns(discarded)).toBe(0)
      expect(await countRevisions(discarded)).toBe(0)
      expect(
        await count('workflow_commands', 'workflow_name LIKE $1', [
          `${discarded}.%`,
        ]),
      ).toBe(0)
    })

    it('runs each revision on its own workers side by side', async () => {
      const runtime = createRuntime()
      const client = createWorkflowRuntimeClient(runtime)
      const prefix = unique('lanes')
      const lanes = [deploy(prefix), deploy(prefix, 'v1'), deploy(prefix, 'v2')]
      const started = await Promise.all(
        lanes.flatMap((lane) =>
          Array.from({ length: 4 }, (_, index) =>
            client.start(lane.flow, `x${index}`),
          ),
        ),
      )

      // Three fleets poll one command table at once; each may only ever take
      // its own lane, so every output carries one revision throughout.
      await Promise.all(lanes.map((lane) => drain(createRuntime(), lane)))

      const runs = await runtime.store.loadRuns(started.map(({ id }) => id))
      for (const run of runs) {
        const tag = run.executionRevision ?? 'legacy'
        expect(run).toMatchObject({
          status: 'completed',
          output: `${String(run.input)}|step@${tag}|task@${tag}`,
        })
      }
      expect(runs).toHaveLength(12)
    })

    it('fires a slot once when two schedulers race over a versioned schedule', async () => {
      const prefix = unique('fire')
      const v1 = deploy(prefix, 'v1')
      const name = `${prefix}.schedule`
      const first = createRuntime()
      await first.scheduler!.reconcile([
        defineSchedule({
          name,
          runnable: v1.flow,
          input: 'x',
          every: '1h',
          immediately: true,
        }),
      ])

      const fired = await Promise.all([
        first.scheduler!.fireDue(),
        createRuntime().scheduler!.fireDue(),
      ])

      expect(fired[0]!.fired + fired[1]!.fired).toBe(1)
      const { runs } = await first.store.listRuns({ tags: { schedule: name } })
      expect(runs).toMatchObject([
        {
          executionRevision: 'v1',
          graphHash: describeDefinition(v1.flow).graphHash,
        },
      ])
      await first.scheduler!.reconcile([])
    })

    it('serves the claim from the claim index in command order', async () => {
      // Enough ready commands that the planner has a real choice between
      // walking the index in order and sorting a scan.
      const name = `${unique('plan')}.flow`
      await pool.query(
        `
          WITH runs AS (
            INSERT INTO workflow_runs (
              id, kind, name, workflow_name, status, input, root_run_id,
              version, created_at, updated_at
            )
            SELECT id, 'workflow', $1, $1, 'queued', '{}', id, 1, now(), now()
            FROM (
              SELECT gen_random_uuid() AS id FROM generate_series(1, 6000)
            ) ids
            RETURNING id
          )
          INSERT INTO workflow_commands (
            id, kind, run_id, workflow_name, task_name, activity_name,
            revision, run_at
          )
          SELECT gen_random_uuid(), kinds.kind, runs.id, $1, $1, 'step',
            NULL, now() - interval '1 minute'
          FROM runs
          CROSS JOIN (
            VALUES ('continue'::workflow_command_kind),
              ('activity'::workflow_command_kind),
              ('task'::workflow_command_kind)
          ) AS kinds(kind)
        `,
        [name],
      )
      await pool.query('ANALYZE workflow_commands')

      const statements: { sql: string; params: readonly unknown[] }[] = []
      const observed = createRuntime({
        query(sql, params = []) {
          if (/UPDATE workflow_commands/.test(sql)) {
            statements.push({ sql, params })
          }
          return connection.query(sql, params)
        },
        transaction: (handler) => connection.transaction(handler),
      })
      // Both lanes of one name: the unversioned one holds the commands.
      const routes = [{ name }, { name, revision: 'v1' }]
      const worker = { workerId: 'planner', leaseMs: 30_000 }
      await observed.runCoordinationExecutor.claim({
        ...worker,
        workflows: routes,
      })
      await observed.attemptExecutor.claim({
        ...worker,
        workflows: routes,
        tasks: routes,
      })
      expect(statements).toHaveLength(2)

      for (const { sql, params } of statements) {
        const plan = await pool.query<{ 'QUERY PLAN': string }>(
          `EXPLAIN (COSTS OFF) ${sql}`,
          [...params],
        )
        const lines = plan.rows.map((row) => row['QUERY PLAN'])
        const probes = lines.filter((line) =>
          line.includes('Index Scan using workflow_commands_claim_idx'),
        )
        // One ordered probe per command kind the claim covers.
        expect(probes).toHaveLength(sql.includes('candidate_1') ? 2 : 1)
        expect(lines.join('\n')).not.toMatch(
          /Seq Scan on workflow_commands|Bitmap Heap Scan on workflow_commands/,
        )
      }
      await pool.query('DELETE FROM workflow_runs WHERE name = $1', [name])
    })
  },
)
