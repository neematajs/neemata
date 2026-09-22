import { PGlite } from '@electric-sql/pglite'
import * as Context from 'effect/Context'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'

import {
  createPostgresWorkflowConnection,
  createPostgresWorkflowRuntime,
} from '../src/adapters/postgres.ts'
import { installPostgresWorkflowSchemaForTesting } from '../src/adapters/postgres/testing.ts'
import {
  defineTask,
  implementTask,
  runExecutionWorker,
} from '../src/effect/index.ts'
import { startTaskRun } from '../src/runtime/index.ts'
import { fromPromise } from './support/effect.ts'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function readTaskCommandRunAt(
  connection: ReturnType<typeof createPostgresWorkflowConnection>,
  runId: string,
) {
  const command = await connection.query<{ run_at: Date }>(
    `
      SELECT run_at
      FROM workflow_commands
      WHERE kind = 'task' AND run_id = $1
    `,
    [runId],
  )
  const runAt = command.rows[0]?.run_at
  return runAt === undefined ? undefined : new Date(runAt).getTime()
}

async function waitForTaskCommandRunAt(
  connection: ReturnType<typeof createPostgresWorkflowConnection>,
  runId: string,
  predicate: (runAt: number) => boolean,
) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 10_000) {
    const runAt = await readTaskCommandRunAt(connection, runId)
    if (runAt !== undefined) {
      if (predicate(runAt)) return runAt
    }
    await wait(5)
  }
  throw new Error('Timed out waiting for retry command')
}

describe('postgres retry scheduling', () => {
  const createTestContext = () => {
    return Context.empty()
  }

  it('stores exponential retry run_at values in workflow_commands', async () => {
    const connection = createPostgresWorkflowConnection(new PGlite())
    await installPostgresWorkflowSchemaForTesting(connection)
    const runtime = createPostgresWorkflowRuntime({ connection })
    const task = defineTask({
      name: 'postgres.retry-backoff-task',
      input: Schema.Struct({ text: Schema.String }),
      output: Schema.Struct({ id: Schema.String }),
      retry: { attempts: 3, delay: '10ms', backoff: 'exponential' },
    })
    let activeWorker: AbortController | undefined
    const implementation = implementTask(task, {
      pool: 'test',
      handler: () =>
        fromPromise(async () => {
          activeWorker?.abort()
          throw new Error('still failing')
        }),
    })
    const run = await startTaskRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      task,
      input: { text: 'alpha' },
    })

    const firstStartedAt = Date.now()
    activeWorker = new AbortController()
    await runExecutionWorker({
      workflows: [],
      ...runtime,
      context: createTestContext(),
      tasks: [implementation],
      workerId: 'task-worker-1',
      signal: activeWorker.signal,
    })
    const firstCommand = await connection.query<{ run_at: Date }>(
      `
          SELECT run_at
          FROM workflow_commands
          WHERE kind = 'task' AND run_id = $1
        `,
      [run.id],
    )
    const firstRunAt = new Date(firstCommand.rows[0]!.run_at).getTime()
    expect(firstRunAt).toBeGreaterThan(firstStartedAt)
    expect(firstRunAt - firstStartedAt).toBeGreaterThanOrEqual(5)

    await waitForTaskCommandRunAt(
      connection,
      run.id,
      (runAt) => runAt <= Date.now(),
    )
    let secondStartedAt = Date.now()
    let secondRunAt: number | undefined
    const retryStartedAt = Date.now()
    let retryWorkers = 0
    while (Date.now() - retryStartedAt < 5_000) {
      await waitForTaskCommandRunAt(
        connection,
        run.id,
        (runAt) => runAt <= Date.now(),
      )
      secondStartedAt = Date.now()
      activeWorker = new AbortController()
      await runExecutionWorker({
        workflows: [],
        ...runtime,
        context: createTestContext(),
        tasks: [implementation],
        workerId: `task-worker-2-${retryWorkers++}`,
        signal: activeWorker.signal,
      })
      const nextRunAt = await readTaskCommandRunAt(connection, run.id)
      if (nextRunAt !== undefined && nextRunAt > firstRunAt) {
        secondRunAt = nextRunAt
        break
      }
      await wait(5)
    }
    expect(secondRunAt).toBeDefined()

    expect(secondRunAt!).toBeGreaterThan(firstRunAt)
    expect(secondRunAt! - secondStartedAt).toBeGreaterThanOrEqual(15)
  }, 60_000)
})

describe('createAttempt `after`', () => {
  async function failedFirstAttempt() {
    const connection = createPostgresWorkflowConnection(new PGlite())
    await installPostgresWorkflowSchemaForTesting(connection)
    const { store } = createPostgresWorkflowRuntime({ connection })
    const run = await store.createRun({
      workflowName: 'retry-after-attempt',
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

  it('creates the retry while `after` is still current, then hands back the successor', async () => {
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

  it('two concurrent retries of one failure share one successor', async () => {
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

  it('a terminal child still rejects a retry', async () => {
    const { store, ref, first } = await failedFirstAttempt()
    await store.failNodeChild({ ...ref, error: new Error('exhausted') })

    await expect(
      store.createAttempt({ ...ref, input: { value: 1 }, after: first.id }),
    ).rejects.toThrow('Terminal node child')
  })
})
