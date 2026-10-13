import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { PGlite } from '@electric-sql/pglite'
import { describe, expect, it } from 'vitest'
import * as z from 'zod'

import type {
  TaskImplementation,
  WorkflowImplementation,
} from '../src/implement/index.ts'
import type { AnyTaskDefinition, AnyWorkflowDefinition } from '../src/index.ts'
import type { RouteRef } from '../src/runtime/commands.ts'
import type { WorkflowRuntimeAdapter } from '../src/runtime/index.ts'
import {
  createPostgresWorkflowConnection,
  createPostgresWorkflowRuntime,
  verifyPostgresWorkflowSchema,
  type WorkflowPostgresConnection,
} from '../src/adapters/postgres.ts'
import { installPostgresWorkflowSchemaForTesting } from '../src/adapters/postgres/testing.ts'
import {
  defineSchedule,
  defineTask,
  defineWorkflow,
  implementTask,
  implementWorkflow,
} from '../src/index.ts'
import {
  canonicalJson,
  captureGraphPresentation,
  projectStructure,
} from '../src/inspector/index.ts'
import { continueRunCommand } from '../src/runtime/commands.ts'
import {
  childRunDefinitionInput,
  describeDefinition,
  runDefinitionInput,
} from '../src/runtime/definition.ts'
import {
  createWorkflowRuntimeClient,
  runExecutionWorker,
  runWorkflowWorker,
  StaleWriteFenceError,
  WorkflowDefinitionConflictError,
  WorkflowIdempotencyConflictError,
  WorkflowRunConflictError,
} from '../src/runtime/index.ts'
import { startStoredScheduleRun } from '../src/runtime/scheduler.ts'

const text = z.string()
const quiet = { reaping: false, runTimeouts: false } as const

async function createDatabase() {
  const db = new PGlite()
  const connection = createPostgresWorkflowConnection(db)
  await installPostgresWorkflowSchemaForTesting(connection)
  const runtime = createPostgresWorkflowRuntime({ connection })
  const client = createWorkflowRuntimeClient(runtime)

  return { db, connection, runtime, client }
}

function unique(label: string) {
  return `pg.${label}.${randomUUID().slice(0, 8)}`
}

/**
 * One deployed generation of a task and a workflow that runs an activity and
 * then the task. Handlers stamp their revision, so an output proves which code
 * ran.
 */
function deploy(prefix: string, revision?: string, title?: string) {
  const tag = revision ?? 'legacy'
  const labels = title === undefined ? {} : { title }

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
    ...labels,
  })
    .activity('step', { input: text, output: text, ...labels })
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

type Served = {
  readonly workflows: readonly WorkflowImplementation<
    AnyWorkflowDefinition,
    any
  >[]
  readonly tasks: readonly TaskImplementation<AnyTaskDefinition, any>[]
}

function serve(...deployments: readonly Served[]): Served {
  return {
    workflows: deployments.flatMap(({ workflows }) => workflows),
    tasks: deployments.flatMap(({ tasks }) => tasks),
  }
}

/** Runs both worker roles until neither finds work, and counts what they did. */
async function drain(runtime: WorkflowRuntimeAdapter, served: Served) {
  let processed = 0
  for (let pass = 0; pass < 200; pass++) {
    const coordination = await runWorkflowWorker({
      ...runtime,
      ...quiet,
      workflows: served.workflows,
      workerId: 'coordinator',
    })
    const execution = await runExecutionWorker({
      ...runtime,
      reaping: false,
      workflows: served.workflows,
      tasks: served.tasks,
      workerId: 'execution',
    })
    const done = coordination.processed + execution.processed
    if (done === 0) return processed
    processed += done
  }
  throw new Error('Workers did not settle')
}

type Tally = {
  readonly runs: number
  readonly commands: number
  readonly graphs: number
  readonly revisions: number
}

async function tally(connection: WorkflowPostgresConnection) {
  const { rows } = await connection.query<Tally>(`
    SELECT
      (SELECT count(*)::int FROM workflow_runs) AS runs,
      (SELECT count(*)::int FROM workflow_commands) AS commands,
      (SELECT count(*)::int FROM workflow_graphs) AS graphs,
      (SELECT count(*)::int FROM workflow_revisions) AS revisions
  `)
  return rows[0]!
}

/**
 * Answers the first statement matching `pattern` with no rows: the read a
 * creation makes before writing then misses what a concurrent writer already
 * committed, which is how a lost race looks from inside one session.
 */
function hideFirst(
  connection: WorkflowPostgresConnection,
  pattern: RegExp,
): WorkflowPostgresConnection {
  let hidden = false
  function wrap(
    target: WorkflowPostgresConnection,
  ): WorkflowPostgresConnection {
    return {
      async query(sql, params = []) {
        if (!hidden && pattern.test(sql)) {
          hidden = true
          return { rows: [] }
        }
        return target.query(sql, params)
      },
      transaction: (handler) => target.transaction((tx) => handler(wrap(tx))),
    }
  }
  return wrap(connection)
}

function failOn(
  connection: WorkflowPostgresConnection,
  pattern: RegExp,
): WorkflowPostgresConnection {
  function wrap(
    target: WorkflowPostgresConnection,
  ): WorkflowPostgresConnection {
    return {
      async query(sql, params = []) {
        if (pattern.test(sql)) throw new Error('forced statement failure')
        return target.query(sql, params)
      },
      transaction: (handler) => target.transaction((tx) => handler(wrap(tx))),
    }
  }
  return wrap(connection)
}

const savedRevisionsRead = /FROM workflow_revisions r/
const savedGraphsRead = /FROM workflow_graphs/
const idempotencyRead = /WHERE\s+idempotency_key\s*=/
const uniqueRead = /WHERE\s+unique_key\s*=/

const legacy = {
  taskRun: '00000000-0000-4000-8000-0000000000a1',
  taskAttempt: '00000000-0000-4000-8000-0000000000a2',
  queuedRun: '00000000-0000-4000-8000-0000000000b1',
  activityRun: '00000000-0000-4000-8000-0000000000c1',
  activityAttempt: '00000000-0000-4000-8000-0000000000c2',
  failedRun: '00000000-0000-4000-8000-0000000000d1',
  failedAttempt: '00000000-0000-4000-8000-0000000000d2',
} as const

// Rows as generation 4 wrote them: a dispatched task run, a queued workflow
// run, a workflow run waiting on its first activity, a failed run, and a
// schedule. None of them names a column generation 5 added.
const LEGACY_ROWS = `
INSERT INTO workflow_runs (
  id, kind, name, workflow_name, task_name, status, input, error,
  root_run_id, tags, idempotency_key, version,
  active_since, created_at, updated_at
) VALUES
  ('${legacy.taskRun}', 'task', 'legacy.task', 'legacy.task', 'legacy.task',
   'queued', '"task-input"', NULL, '${legacy.taskRun}', '{}',
   '["legacy","task"]', 1, '2026-01-01', '2026-01-01', '2026-01-01'),
  ('${legacy.queuedRun}', 'workflow', 'legacy.flow', 'legacy.flow', NULL,
   'queued', '"queued-input"', NULL, '${legacy.queuedRun}', '{}',
   NULL, 1, '2026-01-01', '2026-01-01', '2026-01-01'),
  ('${legacy.activityRun}', 'workflow', 'legacy.flow', 'legacy.flow', NULL,
   'running', '"mid-input"', NULL, '${legacy.activityRun}', '{"a":"b"}',
   NULL, 2, '2026-01-01', '2026-01-01', '2026-01-01'),
  ('${legacy.failedRun}', 'workflow', 'legacy.flaky', 'legacy.flaky', NULL,
   'failed', '"failed-input"', '{"name":"Error","message":"boom"}',
   '${legacy.failedRun}', '{}', NULL, 3,
   '2026-01-01', '2026-01-01', '2026-01-01');

INSERT INTO workflow_nodes (
  run_id, name, kind, status, input, error, version, created_at, updated_at
) VALUES
  ('${legacy.taskRun}', '$task', 'task', 'running', '"task-input"', NULL, 3,
   '2026-01-01', '2026-01-01'),
  ('${legacy.activityRun}', 'step', 'activity', 'running', '"mid-input"', NULL,
   3, '2026-01-01', '2026-01-01'),
  ('${legacy.failedRun}', 'step', 'activity', 'failed', '"failed-input"',
   '{"name":"Error","message":"boom"}', 4, '2026-01-01', '2026-01-01');

INSERT INTO workflow_attempts (
  id, run_id, node_name, child_key, status, lease_token, attempt_number,
  retry_attempt_number, input, idempotency_key, error, dispatched_at,
  completed_at
) VALUES
  ('${legacy.taskAttempt}', '${legacy.taskRun}', '$task', '$self', 'started',
   '11111111-1111-4111-8111-111111111111', 1, 1, '"task-input"',
   '["legacy","task"]', NULL, '2026-01-01', NULL),
  ('${legacy.activityAttempt}', '${legacy.activityRun}', 'step', '$self',
   'started', '22222222-2222-4222-8222-222222222222', 1, 1, '"mid-input"',
   NULL, NULL, '2026-01-01', NULL),
  ('${legacy.failedAttempt}', '${legacy.failedRun}', 'step', '$self', 'failed',
   '33333333-3333-4333-8333-333333333333', 1, 1, '"failed-input"', NULL,
   '{"name":"Error","message":"boom"}', '2026-01-01', '2026-01-01');

INSERT INTO workflow_node_children (
  run_id, node_name, child_key, kind, status, ordinal, error,
  current_attempt_id, attempt_count, version, created_at, updated_at
) VALUES
  ('${legacy.taskRun}', '$task', '$self', 'task', 'running', 0, NULL,
   '${legacy.taskAttempt}', 1, 2, '2026-01-01', '2026-01-01'),
  ('${legacy.activityRun}', 'step', '$self', 'activity', 'running', 0, NULL,
   '${legacy.activityAttempt}', 1, 2, '2026-01-01', '2026-01-01'),
  ('${legacy.failedRun}', 'step', '$self', 'activity', 'failed', 0,
   '{"name":"Error","message":"boom"}', '${legacy.failedAttempt}', 1, 3,
   '2026-01-01', '2026-01-01');

INSERT INTO workflow_commands (
  id, kind, run_id, workflow_name, task_name, activity_name, node_name,
  attempt_id, payload, run_at, created_at
) VALUES
  ('00000000-0000-4000-8000-0000000000a3', 'task', '${legacy.taskRun}',
   'legacy.task', 'legacy.task', NULL, '$task', '${legacy.taskAttempt}',
   '{"kind":"taskAttempt","input":"task-input","runId":"${legacy.taskRun}","childKey":"$self","nodeName":"$task","taskName":"legacy.task","attemptId":"${legacy.taskAttempt}","leaseToken":"11111111-1111-4111-8111-111111111111","workflowName":"legacy.task","idempotencyKey":["legacy","task"]}',
   '2026-01-01', '2026-01-01'),
  ('00000000-0000-4000-8000-0000000000b2', 'continue', '${legacy.queuedRun}',
   'legacy.flow', NULL, NULL, NULL, NULL,
   '{"kind":"continueRun","runId":"${legacy.queuedRun}","workflowName":"legacy.flow"}',
   '2026-01-01', '2026-01-01'),
  ('00000000-0000-4000-8000-0000000000c3', 'activity',
   '${legacy.activityRun}', 'legacy.flow', NULL, 'step', 'step',
   '${legacy.activityAttempt}',
   '{"kind":"activityAttempt","input":"mid-input","runId":"${legacy.activityRun}","childKey":"$self","nodeName":"step","attemptId":"${legacy.activityAttempt}","leaseToken":"22222222-2222-4222-8222-222222222222","activityName":"step","workflowName":"legacy.flow"}',
   '2026-01-01', '2026-01-01');

INSERT INTO workflow_schedules (
  id, name, runnable_kind, runnable_name, input, tags, every_ms, enabled,
  next_run_at
) VALUES (
  '00000000-0000-4000-8000-0000000000e1', 'legacy.schedule', 'workflow',
  'legacy.flow', '"scheduled"', '{"team":"legacy"}', 10000, true, '2026-01-01'
);
`

async function createUpgradedDatabase() {
  const db = new PGlite()
  await db.exec(GENERATION_4_SCHEMA)
  await db.exec(LEGACY_ROWS)
  await db.exec(UPGRADE_TO_GENERATION_5)
  const connection = createPostgresWorkflowConnection(db)
  const runtime = createPostgresWorkflowRuntime({ connection })
  const client = createWorkflowRuntimeClient(runtime)

  return { db, connection, runtime, client }
}

type CatalogRow = Record<string, unknown>

/** Everything the two install paths could disagree on, in a stable order. */
async function readCatalog(db: PGlite) {
  const columns = await db.query<CatalogRow>(`
    SELECT table_name, column_name, udt_name, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name LIKE 'workflow_%'
    ORDER BY table_name, column_name
  `)
  const constraints = await db.query<CatalogRow>(`
    SELECT rel.relname AS table_name, c.conname AS name,
      pg_get_constraintdef(c.oid) AS definition
    FROM pg_constraint c
    JOIN pg_class rel ON rel.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = rel.relnamespace
    WHERE n.nspname = current_schema()
      AND rel.relname LIKE 'workflow_%'
      AND c.contype IN ('p', 'u', 'f', 'c')
    ORDER BY rel.relname, c.conname
  `)
  const indexes = await db.query<CatalogRow>(`
    SELECT indexname AS name, indexdef AS definition
    FROM pg_indexes
    WHERE schemaname = current_schema() AND tablename LIKE 'workflow_%'
    ORDER BY indexname
  `)
  return {
    columns: columns.rows,
    constraints: constraints.rows,
    indexes: indexes.rows,
  }
}

const execFileAsync = promisify(execFile)
const packageRoot = fileURLToPath(new URL('..', import.meta.url))

async function exportDrizzleSchema() {
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const { stdout } = await execFileAsync(
    pnpm,
    [
      'exec',
      'drizzle-kit',
      'export',
      '--dialect',
      'postgresql',
      '--schema',
      'tests/fixtures/drizzle-workflow-schema.ts',
    ],
    { cwd: packageRoot, maxBuffer: 1024 * 1024 },
  )
  return stdout
}

describe('generation 4 to 5 upgrade', () => {
  it('refuses a generation 4 database and names the upgrade', async () => {
    const db = new PGlite()
    await db.exec(GENERATION_4_SCHEMA)
    const connection = createPostgresWorkflowConnection(db)

    await expect(verifyPostgresWorkflowSchema(connection)).rejects.toThrow(
      'Unsupported workflow Postgres schema version [4], expected [5]: apply the application-owned schema upgrades up to generation 5 first',
    )
  })

  it('applies to generation 4 only and changes nothing otherwise', async () => {
    const { db, connection } = await createDatabase()
    const before = await readCatalog(db)

    await expect(db.exec(UPGRADE_TO_GENERATION_5)).rejects.toThrow(
      'workflow schema generation is 5, this upgrade applies to generation 4 only',
    )
    await db.exec('ROLLBACK')

    expect(await readCatalog(db)).toStrictEqual(before)
    await expect(
      verifyPostgresWorkflowSchema(connection),
    ).resolves.toBeUndefined()
  })

  it('leaves the same schema as a fresh install and as the drizzle schema', async () => {
    const fresh = await createDatabase()
    const upgraded = await createUpgradedDatabase()
    await expect(
      verifyPostgresWorkflowSchema(fresh.connection),
    ).resolves.toBeUndefined()
    await expect(
      verifyPostgresWorkflowSchema(upgraded.connection),
    ).resolves.toBeUndefined()

    const expected = await readCatalog(fresh.db)
    expect(await readCatalog(upgraded.db)).toStrictEqual(expected)

    // The drizzle schema omits the opt-in search indexes the installers add.
    const drizzle = new PGlite()
    await drizzle.exec(await exportDrizzleSchema())
    const exported = await readCatalog(drizzle)
    expect(exported.constraints).toStrictEqual(expected.constraints)
    expect(exported.columns).toStrictEqual(expected.columns)
    expect(exported.indexes).toStrictEqual(
      expected.indexes.filter(({ name }) => !String(name).endsWith('_gin_idx')),
    )
  })

  it('keeps legacy rows unversioned, routable by the unversioned lane only, and running', async () => {
    const { db, connection, runtime, client } = await createUpgradedDatabase()
    const current = deploy('legacy')
    const flaky = defineWorkflow({
      name: 'legacy.flaky',
      input: text,
      output: text,
    })
      .activity('step', { input: text, output: text })
      .build()
    const flakyImplementation = implementWorkflow(flaky, { pool: 'test' })
      .step(async (input) => `${input}|recovered`)
      .finish(({ step }) => step)
    const served = serve(current, {
      workflows: [flakyImplementation],
      tasks: [],
    })
    const runIds = [
      legacy.taskRun,
      legacy.queuedRun,
      legacy.activityRun,
      legacy.failedRun,
    ]

    // Read back exactly as written: no revision, no graph, no labels.
    const runs = await runtime.store.loadRuns(runIds)
    expect(runs).toHaveLength(4)
    for (const run of runs) {
      expect(run).not.toHaveProperty('executionRevision')
      expect(run).not.toHaveProperty('graphHash')
      expect(await runtime.store.loadGraphPresentation(run.id)).toBeUndefined()
    }
    const unversioned = await runtime.store.listRunSummaries({
      executionRevision: null,
    })
    expect(unversioned.runs.map(({ id }) => id).toSorted()).toStrictEqual(
      runIds,
    )
    expect(
      (await runtime.store.listRuns({ executionRevision: 'v1' })).runs,
    ).toHaveLength(0)
    const [schedule] = await runtime.scheduler!.list()
    expect(schedule).toMatchObject({
      name: 'legacy.schedule',
      input: 'scheduled',
    })
    expect(schedule).not.toHaveProperty('executionRevision')
    expect(schedule).not.toHaveProperty('graphHash')
    expect(schedule).not.toHaveProperty('graphPresentation')

    // A worker of any revision of the same names takes none of the commands.
    const v1Flow = { name: 'legacy.flow', revision: 'v1' }
    const v1Task = { name: 'legacy.task', revision: 'v1' }
    const worker = { workerId: 'versioned', leaseMs: 30_000 }
    expect(
      await runtime.runCoordinationExecutor.claim({
        ...worker,
        workflows: [v1Flow],
      }),
    ).toBeNull()
    expect(
      await runtime.attemptExecutor.claim({
        ...worker,
        workflows: [v1Flow],
        tasks: [v1Task],
      }),
    ).toBeNull()
    const commands = await connection.query(`
      SELECT kind::text AS kind, revision, delivery_count, lease_token
      FROM workflow_commands ORDER BY 1
    `)
    expect(commands.rows).toStrictEqual([
      {
        kind: 'activity',
        revision: null,
        delivery_count: 0,
        lease_token: null,
      },
      {
        kind: 'continue',
        revision: null,
        delivery_count: 0,
        lease_token: null,
      },
      { kind: 'task', revision: null, delivery_count: 0, lease_token: null },
    ])

    // An unversioned start replays the legacy run that holds its key.
    const replay = await client.start(current.task, 'task-input', {
      idempotencyKey: ['legacy', 'task'],
    })
    expect(replay.id).toBe(legacy.taskRun)
    expect((await tally(connection)).runs).toBe(4)

    // Unversioned code runs all of it: the dispatched task attempt, the
    // queued run from its first node, and the activity already in flight.
    await drain(runtime, served)
    const outputs = new Map<string, unknown>()
    for (const run of await runtime.store.loadRuns(runIds)) {
      outputs.set(run.id, run.status === 'completed' ? run.output : run.status)
    }
    expect(Object.fromEntries(outputs)).toStrictEqual({
      [legacy.taskRun]: 'task-input|task@legacy',
      [legacy.queuedRun]: 'queued-input|step@legacy|task@legacy',
      [legacy.activityRun]: 'mid-input|step@legacy|task@legacy',
      [legacy.failedRun]: 'failed',
    })

    // A manual retry reopens the failed run in place, still unversioned.
    await client.retry(legacy.failedRun)
    await drain(runtime, served)
    const [retried] = await runtime.store.loadRuns([legacy.failedRun])
    expect(retried).toMatchObject({
      status: 'completed',
      output: 'failed-input|recovered',
    })
    expect(retried).not.toHaveProperty('executionRevision')

    // The schedule fires what it stored: a run without a revision or a graph.
    await expect(runtime.scheduler!.fireDue()).resolves.toStrictEqual({
      fired: 1,
    })
    await drain(runtime, served)
    const fired = await runtime.store.listRuns({
      tags: { schedule: 'legacy.schedule' },
    })
    expect(fired.runs).toMatchObject([
      {
        status: 'completed',
        output: 'scheduled|step@legacy|task@legacy',
        tags: { team: 'legacy', schedule: 'legacy.schedule' },
      },
    ])
    expect(fired.runs[0]).not.toHaveProperty('graphHash')

    // Nothing was backfilled: the legacy rows still hold NULL in every
    // generation 5 column, while the child a legacy parent created under the
    // new code has its own graph.
    const stored = await db.query<{ id: string; graph_hash: string | null }>(
      `
        SELECT id, graph_hash FROM workflow_runs
        WHERE id = ANY($1::uuid[])
          AND (execution_revision IS NOT NULL OR graph_hash IS NOT NULL
            OR graph_presentation IS NOT NULL)
      `,
      [runIds],
    )
    expect(stored.rows).toStrictEqual([])
    const children = await runtime.store.listRuns({
      parentRunId: legacy.activityRun,
    })
    expect(children.runs).toMatchObject([
      { kind: 'task', graphHash: describeDefinition(current.task).graphHash },
    ])
  })
})

describe('schema verification', () => {
  it.each([
    {
      change: 'a run-to-graph reference that cascades',
      sql: `
        ALTER TABLE workflow_runs DROP CONSTRAINT workflow_runs_graph_fk;
        ALTER TABLE workflow_runs ADD CONSTRAINT workflow_runs_graph_fk
          FOREIGN KEY (graph_hash) REFERENCES workflow_graphs (graph_hash)
          ON DELETE CASCADE;
      `,
      message:
        'Invalid workflow Postgres schema constraints: workflow_runs_graph_fk',
    },
    {
      change: 'a revision reference that leaves out the graph',
      sql: `
        ALTER TABLE workflow_runs DROP CONSTRAINT workflow_runs_revision_fk;
        ALTER TABLE workflow_runs ADD CONSTRAINT workflow_runs_revision_fk
          FOREIGN KEY (kind, name, execution_revision)
          REFERENCES workflow_revisions (kind, name, revision);
      `,
      message:
        'Invalid workflow Postgres schema constraints: workflow_runs_revision_fk',
    },
    {
      change: 'a revision check with another condition',
      sql: `
        ALTER TABLE workflow_schedules
          DROP CONSTRAINT workflow_schedules_revision_graph_chk;
        ALTER TABLE workflow_schedules
          ADD CONSTRAINT workflow_schedules_revision_graph_chk
          CHECK (execution_revision IS NULL OR graph_hash IS NULL);
      `,
      message:
        'Invalid workflow Postgres schema constraints: workflow_schedules_revision_graph_chk',
    },
    {
      change: 'a missing revision check',
      sql: `
        ALTER TABLE workflow_runs
          DROP CONSTRAINT workflow_runs_revision_graph_chk;
      `,
      message:
        'Missing workflow Postgres schema objects: workflow_runs_revision_graph_chk',
    },
    {
      change: 'a missing command revision',
      sql: 'ALTER TABLE workflow_commands DROP COLUMN revision;',
      message:
        'Invalid workflow Postgres schema columns: workflow_commands.revision',
    },
    {
      change: 'a missing revisions table',
      sql: 'DROP TABLE workflow_revisions CASCADE;',
      message:
        'Missing workflow Postgres schema objects: workflow_revisions, workflow_revisions_pkey, workflow_revisions_graph_key, workflow_revisions_graph_fk, workflow_schedules_revision_fk, workflow_runs_revision_fk',
    },
  ])('rejects $change', async ({ sql, message }) => {
    const { db, connection } = await createDatabase()
    await db.exec(sql)

    await expect(verifyPostgresWorkflowSchema(connection)).rejects.toThrow(
      message,
    )
  })

  it('lets the database refuse a run whose graph is not its revision graph', async () => {
    const { db, client } = await createDatabase()
    const prefix = unique('fk')
    const v1 = deploy(prefix, 'v1')
    await client.start(v1.flow, 'x')
    const taskGraph = describeDefinition(v1.task).graphHash

    function insertRun(revision: string | null, graphHash: string | null) {
      return db.query(
        `
          INSERT INTO workflow_runs (
            id, kind, name, workflow_name, status, input, root_run_id,
            execution_revision, graph_hash, version, created_at, updated_at
          )
          SELECT id, 'workflow', $1, $1, 'queued', '{}', id, $2, $3, 1,
            now(), now()
          FROM gen_random_uuid() AS id
        `,
        [v1.flow.name, revision, graphHash],
      )
    }

    // The task's graph is saved, but revision v1 of the flow has another.
    await expect(insertRun('v1', taskGraph)).rejects.toThrow(
      /workflow_runs_revision_fk/,
    )
    await expect(insertRun('v1', null)).rejects.toThrow(
      /workflow_runs_revision_graph_chk/,
    )
    await expect(insertRun(null, 'f'.repeat(64))).rejects.toThrow(
      /workflow_runs_graph_fk/,
    )
    // MATCH SIMPLE: neither reference applies to a run without a revision.
    await expect(insertRun(null, taskGraph)).resolves.toBeDefined()
    await expect(insertRun(null, null)).resolves.toBeDefined()
  })
})

describe('atomic run creation', () => {
  it('saves the graphs, the manifests, the run and its command together', async () => {
    const { connection, runtime, client } = await createDatabase()
    const prefix = unique('atomic')
    const task = defineTask({
      name: `${prefix}.task`,
      revision: 'v1',
      input: text,
      output: text,
    })
    // Node and case names in an order no sort would produce.
    const flow = defineWorkflow({
      name: `${prefix}.flow`,
      revision: 'v1',
      input: text,
      output: text,
      title: 'Atomic',
    })
      .activity('zeta', { input: text, output: text })
      .branch('alpha', {
        output: text,
        cases: (helpers) => ({
          second: helpers.task(task),
          first: helpers.activity({ input: text, output: text }),
        }),
      })
      .build()
    const { graphHash, manifest } = describeDefinition(flow)

    const run = await client.start(flow, 'x')

    expect(run).toMatchObject({ executionRevision: 'v1', graphHash })
    expect(await tally(connection)).toStrictEqual({
      runs: 1,
      commands: 1,
      graphs: 2,
      revisions: 2,
    })
    const command = await connection.query(
      'SELECT revision, payload FROM workflow_commands',
    )
    expect(command.rows).toStrictEqual([
      {
        revision: 'v1',
        payload: {
          kind: 'continueRun',
          runId: run.id,
          workflowName: flow.name,
          revision: 'v1',
        },
      },
    ])

    // What is stored is the canonical text the hash was taken over, and what
    // is loaded keeps nodes and cases in definition order.
    const stored = await connection.query<{ structure: string }>(
      'SELECT structure FROM workflow_graphs WHERE graph_hash = $1',
      [graphHash],
    )
    expect(stored.rows[0]?.structure).toBe(
      canonicalJson(projectStructure(flow)),
    )
    const graph = await runtime.store.loadGraph(graphHash)
    expect(graph).toStrictEqual({
      graphHash,
      structure: projectStructure(flow),
    })
    expect(graph?.structure).toMatchObject({
      nodes: [
        { name: 'zeta' },
        { name: 'alpha', cases: [{ key: 'second' }, { key: 'first' }] },
      ],
    })
    expect(
      await runtime.store.loadRevision({
        kind: 'workflow',
        name: flow.name,
        revision: 'v1',
      }),
    ).toStrictEqual(manifest)
    expect(await runtime.store.loadGraphPresentation(run.id)).toStrictEqual(
      captureGraphPresentation(flow),
    )
  })

  it('leaves nothing behind when the caller rolls its transaction back', async () => {
    const { connection } = await createDatabase()
    const v1 = deploy(unique('rollback'), 'v1')
    // Statements on the base connection would commit on their own, or wait
    // for the very transaction they were meant to join.
    let joined = false
    const base: WorkflowPostgresConnection = {
      query(sql, params) {
        if (joined) throw new Error(`Left the caller transaction: ${sql}`)
        return connection.query(sql, params)
      },
      transaction(handler) {
        if (joined) throw new Error('Left the caller transaction')
        return connection.transaction(handler)
      },
    }
    const client = createWorkflowRuntimeClient(
      createPostgresWorkflowRuntime({ connection: base }),
    )
    const rollback = new Error('caller rolled back')

    await expect(
      connection.transaction(async (tx) => {
        joined = true
        const workflowRun = await client.start(v1.flow, 'x', { connection: tx })
        const taskRun = await client.start(v1.task, 'x', { connection: tx })
        expect(workflowRun.executionRevision).toBe('v1')
        expect(taskRun.executionRevision).toBe('v1')
        expect(await tally(tx)).toStrictEqual({
          runs: 2,
          commands: 2,
          graphs: 2,
          revisions: 2,
        })
        throw rollback
      }),
    ).rejects.toBe(rollback)
    joined = false

    expect(await tally(connection)).toStrictEqual({
      runs: 0,
      commands: 0,
      graphs: 0,
      revisions: 0,
    })
  })

  it('saves no definition when the run itself cannot be written', async () => {
    const { connection } = await createDatabase()
    const v1 = deploy(unique('norun'), 'v1')
    const failing = createPostgresWorkflowRuntime({
      connection: failOn(connection, /INSERT INTO workflow_runs/),
    })

    await expect(
      failing.store.createRun({
        workflowName: v1.flow.name,
        input: 'x',
        ...runDefinitionInput(v1.flow),
      }),
    ).rejects.toThrow('forced statement failure')

    expect(await tally(connection)).toStrictEqual({
      runs: 0,
      commands: 0,
      graphs: 0,
      revisions: 0,
    })
  })

  it('keeps a transaction usable after each kind of refused run', async () => {
    const { connection } = await createDatabase()
    const prefix = unique('usable')
    const v1 = deploy(prefix, 'v1')
    const v2 = deploy(prefix, 'v2')
    const key = { key: [prefix], scope: 'active', behavior: 'join' } as const
    const input = { workflowName: v1.flow.name, input: 'x' }

    const survivor = await connection.transaction(async (tx) => {
      const { store } = createPostgresWorkflowRuntime({ connection: tx })
      const first = await store.createRun({
        ...input,
        ...runDefinitionInput(v1.flow),
        idempotencyKey: [prefix],
        unique: key,
      })

      await expect(
        store.createRun({
          ...input,
          ...runDefinitionInput(reshape(prefix, 'v1')),
        }),
      ).rejects.toThrow(WorkflowDefinitionConflictError)
      await expect(
        store.createRun({
          ...input,
          ...runDefinitionInput(v2.flow),
          idempotencyKey: [prefix],
        }),
      ).rejects.toMatchObject({
        name: 'WorkflowIdempotencyConflictError',
        runId: first.id,
      })
      await expect(
        store.createRun({
          ...input,
          ...runDefinitionInput(v2.flow),
          unique: key,
        }),
      ).rejects.toThrow(WorkflowRunConflictError)

      return store.createRun({ ...input, ...runDefinitionInput(v1.flow) })
    })

    // The refused runs were refused before anything of theirs was written.
    expect(await tally(connection)).toStrictEqual({
      runs: 2,
      commands: 0,
      graphs: 2,
      revisions: 2,
    })
    expect(survivor.executionRevision).toBe('v1')
  })
})

describe('definition conflicts', () => {
  it('accepts an equal manifest that a concurrent start saved first', async () => {
    const { connection, client } = await createDatabase()
    const v1 = deploy(unique('samerace'), 'v1')
    const first = await client.start(v1.flow, 'x')
    const racing = createWorkflowRuntimeClient(
      createPostgresWorkflowRuntime({
        connection: hideFirst(connection, savedRevisionsRead),
      }),
    )

    const second = await racing.start(v1.flow, 'y')

    expect(second.id).not.toBe(first.id)
    expect(await tally(connection)).toStrictEqual({
      runs: 2,
      commands: 2,
      graphs: 2,
      revisions: 2,
    })
  })

  it('refuses another manifest that lost the race, without a run or a stray graph', async () => {
    const { connection, client } = await createDatabase()
    const prefix = unique('lostrace')
    const v1 = deploy(prefix, 'v1')
    await client.start(v1.flow, 'x')
    const before = await tally(connection)
    const racing = createWorkflowRuntimeClient(
      createPostgresWorkflowRuntime({
        connection: hideFirst(connection, savedRevisionsRead),
      }),
    )

    await expect(racing.start(reshape(prefix, 'v1'), 'y')).rejects.toThrow(
      `workflow [${prefix}.flow@v1] is already saved with a different graph or different child revisions`,
    )

    expect(await tally(connection)).toStrictEqual(before)
  })

  it.each([
    { path: 'before writing', hide: undefined },
    { path: 'after losing the race to save it', hide: savedGraphsRead },
  ])(
    'refuses other content under a saved graph hash $path',
    async ({ hide }) => {
      const { connection, client } = await createDatabase()
      const prefix = unique('collision')
      const v1 = deploy(prefix, 'v1')
      const v2 = deploy(prefix, 'v2')
      const { graphHash } = describeDefinition(v1.flow)
      await client.start(v1.flow, 'x')
      // What a hash collision would look like: the row under this hash holds
      // the canonical text of some other structure.
      await connection.query(
        'UPDATE workflow_graphs SET structure = $2 WHERE graph_hash = $1',
        [graphHash, canonicalJson(projectStructure(v1.task))],
      )
      const before = await tally(connection)
      const starting = createWorkflowRuntimeClient(
        createPostgresWorkflowRuntime({
          connection: hide ? hideFirst(connection, hide) : connection,
        }),
      )

      // v2 has the same graph as v1, and nothing else of it is saved yet.
      await expect(starting.start(v2.flow, 'y')).rejects.toThrow(
        `Graph [${graphHash}] is already saved with different content`,
      )

      expect(await tally(connection)).toStrictEqual(before)
    },
  )
})

describe('idempotency and unique keys after a lost insert race', () => {
  async function setup(label: string, read: RegExp) {
    const { connection, runtime } = await createDatabase()
    const prefix = unique(label)
    const racing = createPostgresWorkflowRuntime({
      connection: hideFirst(connection, read),
    })
    function input(flow: AnyWorkflowDefinition) {
      return {
        workflowName: flow.name,
        input: 'x',
        ...runDefinitionInput(flow),
      }
    }
    return { connection, runtime, racing, prefix, input }
  }

  it('replays the key for the same revision', async () => {
    const { connection, runtime, racing, prefix, input } = await setup(
      'idemsame',
      idempotencyRead,
    )
    const v1 = deploy(prefix, 'v1')
    const run = { ...input(v1.flow), idempotencyKey: [prefix] }
    const first = await runtime.atomicStart!.startWorkflowRun({ run })

    const replay = await racing.atomicStart!.startWorkflowRun({ run })

    expect(replay.id).toBe(first.id)
    expect(await tally(connection)).toMatchObject({ runs: 1, commands: 1 })
  })

  it('conflicts with the holder of the key for another revision', async () => {
    const { connection, runtime, racing, prefix, input } = await setup(
      'idemother',
      idempotencyRead,
    )
    const v1 = deploy(prefix, 'v1')
    const v2 = deploy(prefix, 'v2')
    const idempotencyKey = [prefix]
    const first = await runtime.atomicStart!.startWorkflowRun({
      run: { ...input(v1.flow), idempotencyKey },
    })
    const before = await tally(connection)

    const conflict = await racing
      .atomicStart!.startWorkflowRun({
        run: { ...input(v2.flow), idempotencyKey },
      })
      .catch((error: unknown) => error)

    expect(conflict).toBeInstanceOf(WorkflowIdempotencyConflictError)
    expect(conflict).toMatchObject({ runId: first.id })
    // v2 saved its definitions before its insert lost; they went with it.
    expect(await tally(connection)).toStrictEqual(before)
  })

  it('replays an unversioned key for an unversioned start', async () => {
    const { connection, runtime, racing, prefix } = await setup(
      'idemlegacy',
      idempotencyRead,
    )
    // As generation 4 created it: neither a revision nor a graph.
    const run = {
      workflowName: `${prefix}.flow`,
      input: 'x',
      idempotencyKey: [prefix],
    }
    const first = await runtime.store.createRun(run)

    const replay = await racing.atomicStart!.startWorkflowRun({
      run: { ...run, ...runDefinitionInput(deploy(prefix).flow) },
    })

    expect(replay.id).toBe(first.id)
    expect(replay).not.toHaveProperty('graphHash')
    expect(await tally(connection)).toMatchObject({ runs: 1, commands: 0 })
  })

  it('joins a unique key only as the same workflow and revision', async () => {
    const { connection, runtime, racing, prefix, input } = await setup(
      'join',
      uniqueRead,
    )
    const v1 = deploy(prefix, 'v1')
    const v2 = deploy(prefix, 'v2')
    const join = { key: [prefix], scope: 'active', behavior: 'join' } as const
    const first = await runtime.atomicStart!.startWorkflowRun({
      run: { ...input(v1.flow), unique: join },
    })
    const before = await tally(connection)

    const refused = await racing
      .atomicStart!.startWorkflowRun({
        run: { ...input(v2.flow), unique: join },
      })
      .catch((error: unknown) => error)

    expect(refused).toBeInstanceOf(WorkflowRunConflictError)
    expect(refused).toMatchObject({
      runId: first.id,
      status: 'queued',
      scope: 'active',
      holder: { kind: 'workflow', name: v1.flow.name, revision: 'v1' },
    })
    expect(await tally(connection)).toStrictEqual(before)

    // The preflight read is no longer hidden, so this is the other path.
    const joined = await racing.atomicStart!.startWorkflowRun({
      run: { ...input(v1.flow), unique: join },
    })
    expect(joined.id).toBe(first.id)
    await expect(
      racing.atomicStart!.startWorkflowRun({
        run: { ...input(v2.flow), unique: join },
      }),
    ).rejects.toMatchObject({ runId: first.id, holder: { revision: 'v1' } })
    expect(await tally(connection)).toStrictEqual(before)
  })

  it('joins the same revision that won the insert', async () => {
    const { connection, runtime, racing, prefix, input } = await setup(
      'joinsame',
      uniqueRead,
    )
    const v1 = deploy(prefix, 'v1')
    const join = { key: [prefix], scope: 'all', behavior: 'join' } as const
    const run = { ...input(v1.flow), unique: join }
    const first = await runtime.atomicStart!.startWorkflowRun({ run })

    const joined = await racing.atomicStart!.startWorkflowRun({ run })

    expect(joined.id).toBe(first.id)
    expect(await tally(connection)).toMatchObject({ runs: 1, commands: 1 })
  })

  it('rejects as before, naming no holder', async () => {
    const { runtime, racing, prefix, input } = await setup('reject', uniqueRead)
    const v1 = deploy(prefix, 'v1')
    const reject = {
      key: [prefix],
      scope: 'active',
      behavior: 'reject',
    } as const
    const run = { ...input(v1.flow), unique: reject }
    const first = await runtime.atomicStart!.startWorkflowRun({ run })

    const refused = await racing
      .atomicStart!.startWorkflowRun({ run })
      .catch((error: unknown) => error)

    expect(refused).toBeInstanceOf(WorkflowRunConflictError)
    expect(refused).toMatchObject({ runId: first.id })
    expect((refused as WorkflowRunConflictError).holder).toBeUndefined()
  })
})

describe('child runs of a versioned parent', () => {
  /** A v1 parent whose `child` node is ready to create its child run. */
  async function setup(label: string) {
    const { connection, runtime, client } = await createDatabase()
    const prefix = unique(label)
    function declare(revision: string) {
      const child = defineWorkflow({
        name: `${prefix}.child`,
        revision,
        input: text,
        output: text,
        title: `Child ${revision}`,
      })
        .activity('step', { input: text, output: text })
        .build()
      const parent = defineWorkflow({
        name: `${prefix}.parent`,
        revision,
        input: text,
        output: text,
      })
        .workflow('child', child)
        .build()
      return { child, parent }
    }
    const v1 = declare('v1')
    const run = await client.start(v1.parent, 'x')
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
    const fence = { runLease: lease }

    function params(child: ReturnType<typeof declare>['child']) {
      return {
        runId: run.id,
        nodeName,
        childKey,
        childKind: 'workflow' as const,
        childName: child.name,
        input: 'x',
        rootRunId: run.rootRunId,
        // A versioned parent saved its closure at start: no bundle here.
        ...childRunDefinitionInput(run, child),
        fence,
      }
    }
    async function linked() {
      const { children } = await runtime.store.loadNodeChildren({
        runId: run.id,
        nodeName,
      })
      return children[0]!
    }
    return { connection, runtime, declare, v1, run, lease, params, linked }
  }

  it('creates, links and replays a child pinned to the saved revision', async () => {
    const { connection, runtime, declare, v1, run, params, linked } =
      await setup('child')
    const input = params(v1.child)
    expect(input).not.toHaveProperty('definitions')
    const before = await tally(connection)

    const created = await runtime.store.ensureChildRun(input)

    expect(created.created).toBe(true)
    expect(created.childRun).toMatchObject({
      parentRunId: run.id,
      executionRevision: 'v1',
      graphHash: describeDefinition(v1.child).graphHash,
    })
    expect(created.child).toMatchObject({
      childRunId: created.childRun.id,
      status: 'running',
    })
    expect(
      await runtime.store.loadGraphPresentation(created.childRun.id),
    ).toStrictEqual(captureGraphPresentation(v1.child))
    // The child wrote a run and nothing shared.
    expect(await tally(connection)).toStrictEqual({ ...before, runs: 2 })

    const replay = await runtime.store.ensureChildRun(input)
    expect(replay.created).toBe(false)
    expect(replay.childRun.id).toBe(created.childRun.id)

    // Another revision of the same child is a different run.
    await expect(
      runtime.store.ensureChildRun(params(declare('v2').child)),
    ).rejects.toThrow('Conflicting child run')
    expect((await linked()).childRunId).toBe(created.childRun.id)
    expect(await tally(connection)).toStrictEqual({ ...before, runs: 2 })
  })

  it('creates no child and no link for a revision nobody saved', async () => {
    const { connection, runtime, declare, params, linked } =
      await setup('childmissing')
    const before = await tally(connection)

    await expect(
      runtime.store.ensureChildRun(params(declare('v2').child)),
    ).rejects.toThrow(WorkflowDefinitionConflictError)

    expect(await linked()).toMatchObject({ status: 'pending' })
    expect(await linked()).not.toHaveProperty('childRunId')
    expect(await tally(connection)).toStrictEqual(before)
  })

  it('writes nothing under a fence that no longer holds', async () => {
    const { connection, runtime, v1, lease, params, linked } =
      await setup('childfence')
    const before = await tally(connection)
    await runtime.store.releaseRunLease(lease)

    await expect(
      runtime.store.ensureChildRun(params(v1.child)),
    ).rejects.toThrow(StaleWriteFenceError)

    expect(await linked()).not.toHaveProperty('childRunId')
    expect(await tally(connection)).toStrictEqual(before)
  })

  it('rolls the child run back when its link cannot be written', async () => {
    const { connection, v1, params, linked } = await setup('childlink')
    const before = await tally(connection)
    const failing = createPostgresWorkflowRuntime({
      connection: failOn(connection, /SET child_run_id = \$4/),
    })

    await expect(
      failing.store.ensureChildRun(params(v1.child)),
    ).rejects.toThrow('forced statement failure')

    expect(await linked()).not.toHaveProperty('childRunId')
    expect(await tally(connection)).toStrictEqual(before)
  })
})

describe('command claims', () => {
  const kinds = ['continue', 'activity', 'task'] as const
  type Kind = (typeof kinds)[number]
  const leaseMs = 30_000

  /** One command of `kind` in each lane of one name: v1, unversioned, v2. */
  async function setup(kind: Kind) {
    const { connection, runtime } = await createDatabase()
    const name = `${unique('claim')}.flow`
    const { runCoordinationExecutor, attemptExecutor } = runtime

    const runIds = new Map<string | undefined, string>()
    // v1 is enqueued first, so a lane that leaked would hand it out first.
    for (const revision of ['v1', undefined, 'v2']) {
      const definition = defineWorkflow({
        name,
        revision,
        input: text,
        output: text,
      })
        .activity('step', { input: text, output: text })
        .build()
      const run = await runtime.store.createRun({
        workflowName: name,
        input: 'x',
        ...runDefinitionInput(definition),
      })
      runIds.set(revision, run.id)
      const attempt = {
        workflowName: name,
        ...(revision === undefined ? {} : { revision }),
        runId: run.id,
        childKey: '$self',
        attemptId: randomUUID(),
        leaseToken: randomUUID(),
        input: 'x',
      }
      if (kind === 'continue') {
        await runCoordinationExecutor.enqueue(continueRunCommand(run))
      } else if (kind === 'activity') {
        await attemptExecutor.dispatchActivity({
          ...attempt,
          kind: 'activityAttempt',
          activityName: 'step',
          nodeName: 'step',
        })
      } else {
        await attemptExecutor.dispatchTask({
          ...attempt,
          kind: 'taskAttempt',
          taskName: name,
          nodeName: '$task',
        })
      }
    }

    function claim(workerId: string, routes: readonly RouteRef[]) {
      const worker = { workerId, leaseMs }
      if (kind === 'continue') {
        return runCoordinationExecutor.claim({ ...worker, workflows: routes })
      }
      return kind === 'activity'
        ? attemptExecutor.claim({ ...worker, workflows: routes, tasks: [] })
        : attemptExecutor.claim({ ...worker, workflows: [], tasks: routes })
    }
    async function rows() {
      const { rows } = await connection.query<{
        revision: string | null
        lease_owner: string | null
        delivery_count: number
      }>(`
        SELECT revision, lease_owner, delivery_count
        FROM workflow_commands
        ORDER BY revision NULLS FIRST
      `)
      return rows
    }
    function route(revision?: string): RouteRef {
      return revision === undefined ? { name } : { name, revision }
    }
    return { connection, runtime, name, runIds, claim, rows, route }
  }

  it.each(kinds)(
    'hands a %s command to its exact route only, takeovers included',
    async (kind) => {
      const { connection, name, runIds, claim, rows, route } = await setup(kind)
      const untouched = [
        { revision: null, lease_owner: null, delivery_count: 0 },
        { revision: 'v1', lease_owner: null, delivery_count: 0 },
        { revision: 'v2', lease_owner: null, delivery_count: 0 },
      ]

      // Neither another revision nor another name of the same revision.
      expect(await claim('stranger', [route('v3')])).toBeNull()
      expect(
        await claim('stranger', [{ name: `${name}.other`, revision: 'v1' }]),
      ).toBeNull()
      expect(await rows()).toStrictEqual(untouched)

      for (const revision of ['v2', undefined, 'v1']) {
        const lane = revision ?? 'unversioned'
        const claimed = await claim(`worker-${lane}`, [route(revision)])
        expect(claimed?.command.runId).toBe(runIds.get(revision))
        expect(claimed?.command.revision).toBe(revision)
      }
      const leased = [
        {
          revision: null,
          lease_owner: 'worker-unversioned',
          delivery_count: 0,
        },
        { revision: 'v1', lease_owner: 'worker-v1', delivery_count: 0 },
        { revision: 'v2', lease_owner: 'worker-v2', delivery_count: 0 },
      ]
      expect(await rows()).toStrictEqual(leased)

      // An expired v1 lease is no business of workers that do not serve v1:
      // they neither take it over nor count a delivery against it.
      await connection.query(
        `UPDATE workflow_commands SET lease_expires_at = now() - interval '1 second' WHERE revision = 'v1'`,
      )
      expect(await claim('other-lanes', [route(), route('v2')])).toBeNull()
      expect(await rows()).toStrictEqual(leased)

      const takeover = await claim('successor', [route('v2'), route('v1')])
      expect(takeover?.command.runId).toBe(runIds.get('v1'))
      expect(await rows()).toStrictEqual([
        leased[0],
        { revision: 'v1', lease_owner: 'successor', delivery_count: 1 },
        leased[2],
      ])
    },
  )

  it('applies the activity filter within a route', async () => {
    const { runtime, runIds, rows, route } = await setup('activity')
    const worker = { workerId: 'filtered', leaseMs, tasks: [] }
    const before = await rows()

    expect(
      await runtime.attemptExecutor.claim({
        ...worker,
        workflows: [route('v1')],
        activityNames: ['other'],
      }),
    ).toBeNull()
    expect(await rows()).toStrictEqual(before)

    const claimed = await runtime.attemptExecutor.claim({
      ...worker,
      workflows: [route('v1')],
      activityNames: ['other', 'step'],
    })
    expect(claimed?.command.runId).toBe(runIds.get('v1'))
  })

  it('answers an empty route list without a statement', async () => {
    const { connection } = await createDatabase()
    let statements = 0
    const counted = createPostgresWorkflowRuntime({
      connection: {
        query(sql, params) {
          statements++
          return connection.query(sql, params)
        },
        transaction: (handler) => connection.transaction(handler),
      },
    })
    const worker = { workerId: 'idle', leaseMs }
    const served = [{ name: 'some.flow', revision: 'v1' }]

    expect(
      await counted.runCoordinationExecutor.claim({ ...worker, workflows: [] }),
    ).toBeNull()
    expect(
      await counted.attemptExecutor.claim({
        ...worker,
        workflows: [],
        tasks: [],
      }),
    ).toBeNull()
    // Workflows whose activities are all filtered out serve no activity.
    expect(
      await counted.attemptExecutor.claim({
        ...worker,
        workflows: served,
        activityNames: [],
        tasks: [],
      }),
    ).toBeNull()
    expect(statements).toBe(0)

    await counted.attemptExecutor.claim({
      ...worker,
      workflows: [],
      tasks: served,
    })
    expect(statements).toBe(1)
  })

  it('runs a parked run once its route is served, having counted nothing against it', async () => {
    const { connection, runtime, client } = await createDatabase()
    const prefix = unique('parked')
    const v1 = deploy(prefix, 'v1')
    const others = serve(deploy(prefix), deploy(prefix, 'v2'))
    const workflowRun = await client.start(v1.flow, 'x')
    const taskRun = await client.start(v1.task, 'y')

    expect(await drain(runtime, others)).toBe(0)
    const parked = await connection.query(`
      SELECT kind::text AS kind, revision, delivery_count, lease_token, dead_at
      FROM workflow_commands ORDER BY 1
    `)
    expect(parked.rows).toStrictEqual([
      {
        kind: 'continue',
        revision: 'v1',
        delivery_count: 0,
        lease_token: null,
        dead_at: null,
      },
      {
        kind: 'task',
        revision: 'v1',
        delivery_count: 0,
        lease_token: null,
        dead_at: null,
      },
    ])

    await drain(runtime, serve(v1))
    const [first, second] = await runtime.store.loadRuns([
      workflowRun.id,
      taskRun.id,
    ])
    expect(first).toMatchObject({
      status: 'completed',
      output: 'x|step@v1|task@v1',
    })
    expect(second).toMatchObject({ status: 'completed', output: 'y|task@v1' })
  })
})

describe('schedules', () => {
  const every = '10s'
  const slot = Date.UTC(2026, 0, 1)

  it('saves what a schedule pins with the schedule and reads it back', async () => {
    const { connection, runtime } = await createDatabase()
    const v1 = deploy(unique('schedule'), 'v1', 'Nightly')
    const schedule = defineSchedule({
      name: `${v1.flow.name}.schedule`,
      runnable: v1.flow,
      input: 'x',
      every,
    })
    const { graphHash } = describeDefinition(v1.flow)

    await runtime.scheduler!.reconcile([schedule])

    expect(await runtime.scheduler!.list()).toMatchObject([
      {
        name: schedule.name,
        executionRevision: 'v1',
        graphHash,
        graphPresentation: captureGraphPresentation(v1.flow),
      },
    ])
    expect(await tally(connection)).toMatchObject({ graphs: 2, revisions: 2 })
  })

  it('leaves schedules and definitions untouched when one entry conflicts', async () => {
    const { connection, runtime } = await createDatabase()
    const prefix = unique('schedconflict')
    const v1 = deploy(prefix, 'v1')
    const unrelated = deploy(unique('schedother'), 'v1')
    function schedule(name: string, runnable: AnyWorkflowDefinition) {
      return defineSchedule({ name, runnable, input: 'x', every })
    }
    await runtime.scheduler!.reconcile([schedule('kept', v1.flow)])
    const stored = await runtime.scheduler!.list()
    const before = await tally(connection)

    // The first entry is valid and new; the second edits v1 in place.
    await expect(
      runtime.scheduler!.reconcile([
        schedule('added', unrelated.flow),
        schedule('kept', reshape(prefix, 'v1')),
      ]),
    ).rejects.toThrow(WorkflowDefinitionConflictError)

    expect(await runtime.scheduler!.list()).toStrictEqual(stored)
    expect(await tally(connection)).toStrictEqual(before)

    // Two entries of one reconcile cannot disagree about a revision either.
    const fresh = unique('schedtwice')
    await expect(
      runtime.scheduler!.reconcile([
        schedule('one', deploy(fresh, 'v1').flow),
        schedule('two', reshape(fresh, 'v1')),
      ]),
    ).rejects.toThrow(WorkflowDefinitionConflictError)
    expect(await runtime.scheduler!.list()).toStrictEqual(stored)
    expect(await tally(connection)).toStrictEqual(before)
  })

  it('adopts the run of an unacknowledged slot after a reconcile to another revision', async () => {
    const { connection, runtime } = await createDatabase()
    const prefix = unique('adopt')
    const v1 = deploy(prefix, 'v1', 'First')
    const v2 = deploy(prefix, 'v2', 'Second')
    const name = `${prefix}.schedule`
    function schedule(runnable: AnyWorkflowDefinition) {
      return defineSchedule({ name, runnable, input: 'x', every })
    }
    await runtime.scheduler!.reconcile([schedule(v1.flow)])
    await connection.query('UPDATE workflow_schedules SET next_run_at = $1', [
      new Date(slot),
    ])
    const [pending] = await runtime.scheduler!.list()

    // The fire created its run and died before acknowledging the slot.
    const crashed = await startStoredScheduleRun(runtime, pending!, slot)
    expect(crashed.executionRevision).toBe('v1')
    expect((await runtime.scheduler!.list())[0]).not.toHaveProperty(
      'lastSlotAt',
    )

    await runtime.scheduler!.reconcile([schedule(v2.flow)])
    expect((await runtime.scheduler!.list())[0]).toMatchObject({
      executionRevision: 'v2',
      nextRunAt: slot,
    })

    // The slot's key now belongs to a v1 run the v2 schedule cannot replay:
    // the fire adopts it, wakes it and acknowledges the slot.
    await expect(
      runtime.scheduler!.fireDue({ now: slot }),
    ).resolves.toStrictEqual({ fired: 1 })
    const afterFirst = await runtime.store.listRuns({
      tags: { schedule: name },
    })
    expect(afterFirst.runs.map(({ id }) => id)).toStrictEqual([crashed.id])
    expect((await runtime.scheduler!.list())[0]).toMatchObject({
      lastSlotAt: slot,
      nextRunAt: slot + 10_000,
    })
    expect(await tally(connection)).toMatchObject({ runs: 1, commands: 1 })

    // Nothing is due any more, and the next slot runs the reconciled revision.
    await expect(
      runtime.scheduler!.fireDue({ now: slot }),
    ).resolves.toStrictEqual({ fired: 0 })
    await expect(
      runtime.scheduler!.fireDue({ now: slot + 10_000 }),
    ).resolves.toStrictEqual({ fired: 1 })
    await drain(runtime, serve(v1, v2))
    const { runs } = await runtime.store.listRuns({ tags: { schedule: name } })
    expect(runs).toMatchObject([
      { executionRevision: 'v2', output: 'x|step@v2|task@v2' },
      { id: crashed.id, executionRevision: 'v1', output: 'x|step@v1|task@v1' },
    ])
    // Each run kept the labels of the revision it was created with.
    expect(
      await runtime.store.loadGraphPresentation(runs[0]!.id),
    ).toMatchObject({ title: 'Second' })
    expect(
      await runtime.store.loadGraphPresentation(runs[1]!.id),
    ).toMatchObject({ title: 'First' })
  })
})

describe('run lists', () => {
  it('filters by exact revision, and by null for unversioned runs only', async () => {
    const { connection, runtime, client } = await createDatabase()
    const prefix = unique('list')
    const loose = await client.start(deploy(prefix).flow, 'x')
    const first = await client.start(deploy(prefix, 'v1', 'Labelled').flow, 'x')
    const second = await client.start(deploy(prefix, 'v2').flow, 'x')
    async function ids(executionRevision?: string | null) {
      const filter =
        executionRevision === undefined ? {} : { executionRevision }
      const { runs } = await runtime.store.listRuns(filter)
      const summaries = await runtime.store.listRunSummaries(filter)
      const listed = runs.map(({ id }) => id)
      expect(summaries.runs.map(({ id }) => id)).toStrictEqual(listed)
      return listed
    }

    expect(await ids('v1')).toStrictEqual([first.id])
    expect(await ids(null)).toStrictEqual([loose.id])
    expect(await ids('v3')).toStrictEqual([])
    expect(await ids()).toStrictEqual([second.id, first.id, loose.id])

    // A summary names what a run is pinned to and never carries its labels.
    const { graphHash } = describeDefinition(deploy(prefix, 'v1').flow)
    const summary = (
      await runtime.store.listRunSummaries({ executionRevision: 'v1' })
    ).runs[0]
    expect(summary).toMatchObject({ executionRevision: 'v1', graphHash })
    const detail = (await runtime.store.loadRunDetail(first.id))!
    expect(detail.run).toMatchObject({ executionRevision: 'v1', graphHash })
    const family = await runtime.store.listRunFamily(first.id)
    expect(family[0]?.run).toMatchObject({ executionRevision: 'v1', graphHash })
    let statements = 0
    const observed = createPostgresWorkflowRuntime({
      connection: {
        async query<T extends Record<string, unknown>>(
          sql: string,
          params?: readonly unknown[],
        ) {
          const result = await connection.query<T>(sql, params)
          statements++
          expect(JSON.stringify(result.rows)).not.toContain('Labelled')
          return result
        },
        transaction: (handler) => connection.transaction(handler),
      },
    })
    await observed.store.listRunSummaries()
    await observed.store.loadRunDetail(first.id)
    await observed.store.listRunFamily(first.id)
    expect(statements).toBe(3)
  })
})

describe('retention', () => {
  it('deletes a run with its labels and keeps every shared definition', async () => {
    const { connection, runtime, client } = await createDatabase()
    const prefix = unique('retain')
    const v1 = deploy(prefix, 'v1', 'Kept')
    const ref = {
      kind: 'workflow',
      name: v1.flow.name,
      revision: 'v1',
    } as const
    const { graphHash } = describeDefinition(v1.flow)
    const older = await client.start(v1.flow, 'older')
    const newer = await client.start(v1.flow, 'newer')
    await runtime.scheduler!.reconcile([
      defineSchedule({
        name: `${prefix}.schedule`,
        runnable: v1.flow,
        input: 'x',
        every: '1h',
      }),
    ])
    await drain(runtime, serve(v1))
    const definitions = { graphs: 2, revisions: 2 }
    expect(await tally(connection)).toMatchObject({ runs: 4, ...definitions })

    // Deleting one of two runs sharing a graph.
    await expect(client.deleteRun(older.id)).resolves.toStrictEqual({
      deleted: true,
    })
    expect(await runtime.store.loadGraphPresentation(older.id)).toBeUndefined()
    expect(await runtime.store.loadGraphPresentation(newer.id)).toMatchObject({
      title: 'Kept',
    })
    expect(await tally(connection)).toMatchObject({ runs: 2, ...definitions })

    // Pruning the last run leaves definitions only the schedule refers to.
    await expect(
      runtime.store.pruneTerminalRuns({ olderThan: Date.now() + 60_000 }),
    ).resolves.toMatchObject({ deleted: 1 })
    expect(await tally(connection)).toMatchObject({ runs: 0, ...definitions })

    // And removing the schedule leaves them referenced by nothing at all.
    await runtime.scheduler!.reconcile([])
    expect(await runtime.scheduler!.list()).toHaveLength(0)
    expect(await tally(connection)).toMatchObject({ runs: 0, ...definitions })
    expect(await runtime.store.loadGraph(graphHash)).toStrictEqual({
      graphHash,
      structure: projectStructure(v1.flow),
    })
    expect(await runtime.store.loadRevision(ref)).toStrictEqual(
      describeDefinition(v1.flow).manifest,
    )
  })
})

// The schema generation 4 installed, statement for statement.
const GENERATION_4_SCHEMA = `
CREATE TABLE IF NOT EXISTS workflow_schema_version (
  id integer PRIMARY KEY DEFAULT 1,
  version integer NOT NULL,
  installed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_schema_version_singleton_chk CHECK (id = 1)
);
INSERT INTO workflow_schema_version (id, version)
VALUES (1, 4)
ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'workflow_run_kind' AND typnamespace = current_schema()::regnamespace) THEN
    CREATE TYPE workflow_run_kind AS ENUM ('workflow', 'task');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'workflow_node_kind' AND typnamespace = current_schema()::regnamespace) THEN
    CREATE TYPE workflow_node_kind AS ENUM (
      'activity',
      'task',
      'workflow',
      'branch',
      'parallel',
      'mapTask',
      'mapWorkflow'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'workflow_node_child_kind' AND typnamespace = current_schema()::regnamespace) THEN
    CREATE TYPE workflow_node_child_kind AS ENUM (
      'activity',
      'task',
      'workflow'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'workflow_run_status' AND typnamespace = current_schema()::regnamespace) THEN
    CREATE TYPE workflow_run_status AS ENUM (
      'queued',
      'running',
      'waiting',
      'cancelling',
      'cancelled',
      'failed',
      'completed'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'workflow_node_status' AND typnamespace = current_schema()::regnamespace) THEN
    CREATE TYPE workflow_node_status AS ENUM (
      'pending',
      'running',
      'waiting',
      'cancelling',
      'cancelled',
      'failed',
      'completed'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'workflow_attempt_status' AND typnamespace = current_schema()::regnamespace) THEN
    CREATE TYPE workflow_attempt_status AS ENUM (
      'started',
      'completed',
      'failed',
      'timedOut',
      'cancelled'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'workflow_command_kind' AND typnamespace = current_schema()::regnamespace) THEN
    CREATE TYPE workflow_command_kind AS ENUM (
      'continue',
      'activity',
      'task'
    );
  END IF;
END
$$;;
CREATE TABLE IF NOT EXISTS workflow_schedules (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  runnable_kind workflow_run_kind NOT NULL,
  runnable_name text NOT NULL,
  input jsonb NOT NULL,
  tags jsonb NOT NULL DEFAULT '{}'::jsonb,
  cron text,
  every_ms bigint,
  enabled boolean NOT NULL,
  next_run_at timestamptz NOT NULL,
  last_slot_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_schedules_name_key UNIQUE (name),
  CONSTRAINT workflow_schedules_cadence_chk CHECK ((cron IS NULL) <> (every_ms IS NULL))
);
CREATE INDEX IF NOT EXISTS workflow_schedules_due_idx
ON workflow_schedules (enabled, next_run_at);
CREATE TABLE IF NOT EXISTS workflow_runs (
  id uuid PRIMARY KEY,
  kind workflow_run_kind NOT NULL,
  name text NOT NULL,
  workflow_name text NOT NULL,
  task_name text,
  status workflow_run_status NOT NULL,
  input jsonb NOT NULL,
  output jsonb,
  error jsonb,
  parent_run_id uuid,
  parent_node_name text,
  root_run_id uuid NOT NULL,
  tags jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key jsonb,
  unique_key jsonb,
  unique_scope text,
  unique_behavior text,
  version integer NOT NULL,
  active_since timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
ALTER TABLE workflow_runs
ADD COLUMN IF NOT EXISTS active_since timestamptz,
ADD COLUMN IF NOT EXISTS unique_key jsonb,
ADD COLUMN IF NOT EXISTS unique_scope text,
ADD COLUMN IF NOT EXISTS unique_behavior text;
UPDATE workflow_runs SET active_since = created_at WHERE active_since IS NULL;
ALTER TABLE workflow_runs ALTER COLUMN active_since SET NOT NULL, ALTER COLUMN active_since SET DEFAULT now();
CREATE UNIQUE INDEX IF NOT EXISTS workflow_runs_idempotency_idx
ON workflow_runs (idempotency_key)
WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS workflow_runs_unique_active_idx
ON workflow_runs (unique_key)
WHERE unique_key IS NOT NULL AND unique_scope = 'active'
  AND status NOT IN ('completed', 'cancelled', 'failed');
CREATE UNIQUE INDEX IF NOT EXISTS workflow_runs_unique_all_idx
ON workflow_runs (unique_key)
WHERE unique_key IS NOT NULL AND unique_scope = 'all';
CREATE INDEX IF NOT EXISTS workflow_runs_parent_idx
ON workflow_runs (parent_run_id)
WHERE parent_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS workflow_runs_root_idx
ON workflow_runs (root_run_id);
CREATE INDEX IF NOT EXISTS workflow_runs_prune_idx
ON workflow_runs (status, updated_at)
WHERE parent_run_id IS NULL;
CREATE INDEX IF NOT EXISTS workflow_runs_input_gin_idx
ON workflow_runs USING gin (input jsonb_path_ops);
CREATE INDEX IF NOT EXISTS workflow_runs_tags_gin_idx
ON workflow_runs USING gin (tags jsonb_path_ops);
CREATE TABLE IF NOT EXISTS workflow_nodes (
  run_id uuid NOT NULL,
  name text NOT NULL,
  kind workflow_node_kind NOT NULL,
  status workflow_node_status NOT NULL,
  input jsonb,
  output jsonb,
  error jsonb,
  selected_case text,
  version integer NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (run_id, name)
);
CREATE TABLE IF NOT EXISTS workflow_attempts (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL,
  node_name text NOT NULL,
  child_key text NOT NULL,
  status workflow_attempt_status NOT NULL,
  worker_id text,
  lease_token text,
  attempt_number integer NOT NULL,
  retry_attempt_number integer NOT NULL,
  input jsonb NOT NULL,
  idempotency_key jsonb,
  output jsonb,
  error jsonb,
  dispatched_at timestamptz NOT NULL,
  heartbeat_at timestamptz,
  completed_at timestamptz,
  CONSTRAINT workflow_attempts_child_attempt_key
    UNIQUE (run_id, node_name, child_key, attempt_number)
);
ALTER TABLE workflow_attempts ADD COLUMN IF NOT EXISTS retry_attempt_number integer;
UPDATE workflow_attempts SET retry_attempt_number = attempt_number WHERE retry_attempt_number IS NULL;
ALTER TABLE workflow_attempts ALTER COLUMN retry_attempt_number SET NOT NULL;
CREATE TABLE IF NOT EXISTS workflow_node_children (
  run_id uuid NOT NULL,
  node_name text NOT NULL,
  child_key text NOT NULL,
  kind workflow_node_child_kind NOT NULL,
  status workflow_node_status NOT NULL,
  ordinal integer NOT NULL DEFAULT 0,
  item_key text,
  item jsonb,
  input jsonb,
  output jsonb,
  error jsonb,
  child_run_id uuid,
  cancellation text,
  current_attempt_id uuid,
  attempt_count integer NOT NULL DEFAULT 0,
  version integer NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (run_id, node_name, child_key)
);
CREATE TABLE IF NOT EXISTS workflow_run_leases (
  run_id uuid PRIMARY KEY,
  lease_token text NOT NULL,
  version integer NOT NULL,
  expires_at timestamptz NOT NULL
);
DROP TABLE IF EXISTS workflow_run_events;
CREATE TABLE IF NOT EXISTS workflow_commands (
  id uuid PRIMARY KEY,
  kind workflow_command_kind NOT NULL,
  run_id uuid NOT NULL,
  workflow_name text,
  task_name text,
  activity_name text,
  node_name text,
  attempt_id uuid,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  run_at timestamptz NOT NULL DEFAULT now(),
  priority integer NOT NULL DEFAULT 0,
  lease_owner text,
  lease_token text,
  lease_expires_at timestamptz,
  delivery_count integer NOT NULL DEFAULT 0,
  last_error jsonb,
  dead_at timestamptz,
  reaped_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE workflow_commands
ADD COLUMN IF NOT EXISTS delivery_count integer NOT NULL DEFAULT 0;
ALTER TABLE workflow_commands
ADD COLUMN IF NOT EXISTS last_error jsonb;
ALTER TABLE workflow_commands
ADD COLUMN IF NOT EXISTS dead_at timestamptz,
ADD COLUMN IF NOT EXISTS reaped_at timestamptz;
DO $$
DECLARE
  existing regclass;
  is_partial boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('workflow_commands_claim_idx_install'));
  SELECT i.indexrelid::regclass, i.indpred IS NOT NULL
  INTO existing, is_partial
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
  WHERE c.relname = 'workflow_commands_claim_idx'
    AND i.indrelid = 'workflow_commands'::regclass;
  IF existing IS NOT NULL AND NOT is_partial THEN
    EXECUTE format('DROP INDEX %s', existing);
  END IF;
  IF existing IS NULL OR NOT is_partial THEN
    CREATE INDEX workflow_commands_claim_idx
    ON workflow_commands (kind, priority DESC, run_at, created_at, id)
    WHERE dead_at IS NULL;
  END IF;
END
$$;;
CREATE INDEX IF NOT EXISTS workflow_commands_dead_idx
ON workflow_commands (dead_at)
WHERE dead_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS workflow_commands_run_idx
ON workflow_commands (run_id);
CREATE INDEX IF NOT EXISTS workflow_commands_attempt_idx
ON workflow_commands (attempt_id)
WHERE attempt_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS workflow_commands_continue_dedup_idx
ON workflow_commands (run_id)
WHERE kind = 'continue' AND lease_token IS NULL;
CREATE INDEX IF NOT EXISTS workflow_attempts_node_idx
ON workflow_attempts (run_id, node_name);
CREATE INDEX IF NOT EXISTS workflow_node_children_node_idx
ON workflow_node_children (run_id, node_name);
CREATE INDEX IF NOT EXISTS workflow_node_children_child_run_idx
ON workflow_node_children (child_run_id);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workflow_runs_parent_run_fk' AND conrelid = 'workflow_runs'::regclass
  ) THEN
    ALTER TABLE workflow_runs
    ADD CONSTRAINT workflow_runs_parent_run_fk
    FOREIGN KEY (parent_run_id)
    REFERENCES workflow_runs(id)
    ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workflow_runs_root_run_fk' AND conrelid = 'workflow_runs'::regclass
  ) THEN
    ALTER TABLE workflow_runs
    ADD CONSTRAINT workflow_runs_root_run_fk
    FOREIGN KEY (root_run_id)
    REFERENCES workflow_runs(id)
    ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workflow_runs_parent_node_fk' AND conrelid = 'workflow_runs'::regclass
  ) THEN
    ALTER TABLE workflow_runs
    ADD CONSTRAINT workflow_runs_parent_node_fk
    FOREIGN KEY (parent_run_id, parent_node_name)
    REFERENCES workflow_nodes(run_id, name)
    ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workflow_nodes_run_fk' AND conrelid = 'workflow_nodes'::regclass
  ) THEN
    ALTER TABLE workflow_nodes
    ADD CONSTRAINT workflow_nodes_run_fk
    FOREIGN KEY (run_id)
    REFERENCES workflow_runs(id)
    ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workflow_attempts_node_fk' AND conrelid = 'workflow_attempts'::regclass
  ) THEN
    ALTER TABLE workflow_attempts
    ADD CONSTRAINT workflow_attempts_node_fk
    FOREIGN KEY (run_id, node_name)
    REFERENCES workflow_nodes(run_id, name)
    ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workflow_attempts_child_attempt_key' AND conrelid = 'workflow_attempts'::regclass
  ) THEN
    ALTER TABLE workflow_attempts
    ADD CONSTRAINT workflow_attempts_child_attempt_key
    UNIQUE (run_id, node_name, child_key, attempt_number);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workflow_node_children_run_fk' AND conrelid = 'workflow_node_children'::regclass
  ) THEN
    ALTER TABLE workflow_node_children
    ADD CONSTRAINT workflow_node_children_run_fk
    FOREIGN KEY (run_id)
    REFERENCES workflow_runs(id)
    ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workflow_node_children_node_fk' AND conrelid = 'workflow_node_children'::regclass
  ) THEN
    ALTER TABLE workflow_node_children
    ADD CONSTRAINT workflow_node_children_node_fk
    FOREIGN KEY (run_id, node_name)
    REFERENCES workflow_nodes(run_id, name)
    ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workflow_node_children_child_run_fk' AND conrelid = 'workflow_node_children'::regclass
  ) THEN
    ALTER TABLE workflow_node_children
    ADD CONSTRAINT workflow_node_children_child_run_fk
    FOREIGN KEY (child_run_id)
    REFERENCES workflow_runs(id)
    ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workflow_node_children_current_attempt_fk' AND conrelid = 'workflow_node_children'::regclass
  ) THEN
    ALTER TABLE workflow_node_children
    ADD CONSTRAINT workflow_node_children_current_attempt_fk
    FOREIGN KEY (current_attempt_id)
    REFERENCES workflow_attempts(id)
    ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workflow_run_leases_run_fk' AND conrelid = 'workflow_run_leases'::regclass
  ) THEN
    ALTER TABLE workflow_run_leases
    ADD CONSTRAINT workflow_run_leases_run_fk
    FOREIGN KEY (run_id)
    REFERENCES workflow_runs(id)
    ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workflow_commands_run_fk' AND conrelid = 'workflow_commands'::regclass
  ) THEN
    ALTER TABLE workflow_commands
    ADD CONSTRAINT workflow_commands_run_fk
    FOREIGN KEY (run_id)
    REFERENCES workflow_runs(id)
    ON DELETE CASCADE;
  END IF;
END
$$;;
`

// The application-owned upgrade, as published.
const UPGRADE_TO_GENERATION_5 = `
-- @nmtjs/workflows PostgreSQL schema upgrade: generation 4 -> generation 5
-- (execution revisions and persisted structural graphs).
--
-- Application-owned: run it with your own migration tool. The workflow tables
-- are referenced unqualified, so set search_path first when they do not live
-- in the default schema.
--
-- Step 1 is one short transaction of catalog-only changes. Every new column is
-- nullable and has no default, so no table is rewritten and no existing row is
-- touched: runs, commands and schedules created before the upgrade keep NULL
-- in the new columns and stay in the unversioned lane. There is no backfill.
-- The transaction takes ACCESS EXCLUSIVE locks on workflow_runs,
-- workflow_commands and workflow_schedules; lock_timeout keeps it from queueing
-- behind a long transaction and stalling every worker behind itself. On a
-- timeout nothing has changed: run the file again.
--
-- Step 2 validates the constraints step 1 added as NOT VALID. Validation scans
-- each table under SHARE UPDATE EXCLUSIVE, which blocks neither reads nor
-- writes, so it runs outside the step 1 transaction. Rows written after step 1
-- are checked either way.

-- Step 1 ---------------------------------------------------------------------

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  installed integer;
BEGIN
  SELECT version INTO installed FROM workflow_schema_version WHERE id = 1;
  IF installed IS DISTINCT FROM 4 THEN
    RAISE EXCEPTION
      'workflow schema generation is %, this upgrade applies to generation 4 only',
      COALESCE(installed::text, 'missing');
  END IF;
END
$$;

-- Shared by every run and schedule that names them and never deleted with one.
-- structure and bindings hold canonical JSON as text: saved definitions are
-- compared byte for byte, which jsonb's own key order would not allow.
CREATE TABLE workflow_graphs (
  graph_hash text PRIMARY KEY,
  structure text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workflow_revisions (
  kind workflow_run_kind NOT NULL,
  name text NOT NULL,
  revision text NOT NULL,
  graph_hash text NOT NULL,
  bindings text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_revisions_pkey PRIMARY KEY (kind, name, revision),
  CONSTRAINT workflow_revisions_graph_key
    UNIQUE (kind, name, revision, graph_hash),
  CONSTRAINT workflow_revisions_graph_fk
    FOREIGN KEY (graph_hash) REFERENCES workflow_graphs (graph_hash)
);

ALTER TABLE workflow_runs
  ADD COLUMN execution_revision text,
  ADD COLUMN graph_hash text,
  ADD COLUMN graph_presentation jsonb;

-- No ON DELETE action in either direction: deleting or pruning a run never
-- deletes a graph or a revision, and a referenced one cannot be deleted.
-- The revision reference is MATCH SIMPLE, so unversioned runs are not checked.
ALTER TABLE workflow_runs
  ADD CONSTRAINT workflow_runs_revision_graph_chk
    CHECK (execution_revision IS NULL OR graph_hash IS NOT NULL) NOT VALID,
  ADD CONSTRAINT workflow_runs_graph_fk
    FOREIGN KEY (graph_hash) REFERENCES workflow_graphs (graph_hash) NOT VALID,
  ADD CONSTRAINT workflow_runs_revision_fk
    FOREIGN KEY (kind, name, execution_revision, graph_hash)
    REFERENCES workflow_revisions (kind, name, revision, graph_hash) NOT VALID;

-- The run's revision, copied for routing. NULL is the unversioned lane.
ALTER TABLE workflow_commands
  ADD COLUMN revision text;

ALTER TABLE workflow_schedules
  ADD COLUMN execution_revision text,
  ADD COLUMN graph_hash text,
  ADD COLUMN graph_presentation jsonb;

ALTER TABLE workflow_schedules
  ADD CONSTRAINT workflow_schedules_revision_graph_chk
    CHECK (execution_revision IS NULL OR graph_hash IS NOT NULL) NOT VALID,
  ADD CONSTRAINT workflow_schedules_graph_fk
    FOREIGN KEY (graph_hash) REFERENCES workflow_graphs (graph_hash) NOT VALID,
  ADD CONSTRAINT workflow_schedules_revision_fk
    FOREIGN KEY (runnable_kind, runnable_name, execution_revision, graph_hash)
    REFERENCES workflow_revisions (kind, name, revision, graph_hash) NOT VALID;

UPDATE workflow_schema_version SET version = 5 WHERE id = 1;

COMMIT;

-- Step 2 ---------------------------------------------------------------------

ALTER TABLE workflow_runs
  VALIDATE CONSTRAINT workflow_runs_revision_graph_chk;
ALTER TABLE workflow_runs
  VALIDATE CONSTRAINT workflow_runs_graph_fk;
ALTER TABLE workflow_runs
  VALIDATE CONSTRAINT workflow_runs_revision_fk;
ALTER TABLE workflow_schedules
  VALIDATE CONSTRAINT workflow_schedules_revision_graph_chk;
ALTER TABLE workflow_schedules
  VALIDATE CONSTRAINT workflow_schedules_graph_fk;
ALTER TABLE workflow_schedules
  VALIDATE CONSTRAINT workflow_schedules_revision_fk;
`
