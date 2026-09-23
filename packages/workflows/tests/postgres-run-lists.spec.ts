import { PGlite } from '@electric-sql/pglite'
import { describe, expect, test } from 'vitest'

import {
  createPostgresWorkflowConnection,
  createPostgresWorkflowRuntime,
} from '../src/adapters/postgres.ts'
import { installPostgresWorkflowSchemaForTesting } from '../src/adapters/postgres/testing.ts'
import { createWorkflowRuntimeClient } from '../src/runtime/index.ts'

async function createRuntime() {
  const connection = createPostgresWorkflowConnection(new PGlite())
  await installPostgresWorkflowSchemaForTesting(connection)
  const runtime = createPostgresWorkflowRuntime({ connection })
  return { connection, runtime }
}

describe('run lists', () => {
  test('an empty status selection matches nothing', async () => {
    const { connection, runtime } = await createRuntime()
    await runtime.store.createRun({ workflowName: 'run-lists', input: {} })
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
