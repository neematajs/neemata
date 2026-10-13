import { randomUUID } from 'node:crypto'

import {
  createPostgresWorkflowConnection,
  createPostgresWorkflowRuntime,
} from '../../src/adapters/postgres.ts'
import { createRedisWorkflowRuntime } from '../../src/adapters/redis.ts'
import { revisionsContract } from '../support/revisions.ts'
import {
  createPostgresWorkflowHarness,
  disposeRedisRuntimes,
  postgresTarget,
  redisTargets,
  requireServiceEnv,
} from './helpers.ts'

requireServiceEnv(postgresTarget)

revisionsContract(
  'Postgres server',
  async (options) => {
    const harness = await createPostgresWorkflowHarness()
    const connection = createPostgresWorkflowConnection(harness.pool)
    const runtime = createPostgresWorkflowRuntime({ connection, ...options })
    return { ...runtime, dispose: () => harness.cleanup() }
  },
  { skip: !postgresTarget.url },
)

for (const target of redisTargets) {
  revisionsContract(
    `${target.name} server`,
    (options) => {
      const client = target.createClient()
      const runtime = createRedisWorkflowRuntime({
        client,
        keyPrefix: `nmtjs:test:revisions:${randomUUID()}:`,
        ...options,
      })
      const dispose = () => disposeRedisRuntimes([runtime], [client])
      return { ...runtime, dispose }
    },
    { skip: !target.url },
  )
}
