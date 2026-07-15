import { PGlite } from '@electric-sql/pglite'
import { Container, createLogger } from '@nmtjs/core'
import { t } from '@nmtjs/type'
import { describe, expect, it } from 'vitest'

import {
  createPostgresWorkflowConnection,
  createPostgresWorkflowRuntime,
} from '../src/adapters/postgres.ts'
import { installPostgresWorkflowSchemaForTesting } from '../src/adapters/postgres/testing.ts'
import { defineTask, implementTask } from '../src/index.ts'
import { runExecutionWorker, startTaskRun } from '../src/runtime/index.ts'

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
  const createTestContainer = () => {
    const logger = createLogger({ pinoOptions: { enabled: false } }, 'test')
    return new Container({ logger })
  }

  it('stores exponential retry run_at values in workflow_commands', async () => {
    const connection = createPostgresWorkflowConnection(new PGlite())
    await installPostgresWorkflowSchemaForTesting(connection)
    const runtime = createPostgresWorkflowRuntime({ connection })
    const task = defineTask({
      name: 'postgres.retry-backoff-task',
      input: t.object({ text: t.string() }),
      output: t.object({ id: t.string() }),
      retry: { attempts: 3, delay: '10ms', backoff: 'exponential' },
    })
    let activeWorker: AbortController | undefined
    const implementation = implementTask(task, {
      handler: async () => {
        activeWorker?.abort()
        throw new Error('still failing')
      },
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
      container: createTestContainer(),
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
        container: createTestContainer(),
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
