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
import { runTaskWorker, startTaskRun } from '../src/runtime/index.ts'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

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
    const implementation = implementTask(task, {
      handler: async () => {
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
    await runTaskWorker({
      ...runtime,
      container: createTestContainer(),
      tasks: [implementation],
      workerId: 'task-worker-1',
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

    await wait(15)
    const secondStartedAt = Date.now()
    await runTaskWorker({
      ...runtime,
      container: createTestContainer(),
      tasks: [implementation],
      workerId: 'task-worker-2',
    })
    const secondCommand = await connection.query<{ run_at: Date }>(
      `
        SELECT run_at
        FROM workflow_commands
        WHERE kind = 'task' AND run_id = $1
      `,
      [run.id],
    )
    const secondRunAt = new Date(secondCommand.rows[0]!.run_at).getTime()

    expect(secondRunAt).toBeGreaterThan(firstRunAt)
    expect(secondRunAt - secondStartedAt).toBeGreaterThanOrEqual(15)
  })
})
