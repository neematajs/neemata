import { PGlite } from '@electric-sql/pglite'

import {
  createPostgresWorkflowConnection,
  createPostgresWorkflowRuntime,
} from '../src/adapters/postgres.ts'
import { installPostgresWorkflowSchemaForTesting } from '../src/adapters/postgres/testing.ts'
import { createInMemoryWorkflowRuntime } from '../src/runtime/index.ts'
import { revisionsContract } from './support/revisions.ts'

revisionsContract('in-memory', (options) =>
  createInMemoryWorkflowRuntime(options),
)

revisionsContract('postgres', async (options) => {
  const connection = createPostgresWorkflowConnection(new PGlite())
  await installPostgresWorkflowSchemaForTesting(connection)
  return createPostgresWorkflowRuntime({ connection, ...options })
})
