import { randomUUID } from 'node:crypto'

import type { Pool as PgPool } from 'pg'
import * as Context from 'effect/Context'
import { Redis } from 'ioredis'
import { Redis as Valkey } from 'iovalkey'
import pg from 'pg'

import type { createRedisWorkflowRuntime } from '../../src/adapters/redis.ts'
import {
  createPostgresWorkflowConnection,
  createPostgresWorkflowRuntime,
} from '../../src/adapters/postgres.ts'
import { installPostgresWorkflowSchemaForTesting } from '../../src/adapters/postgres/testing.ts'

const { Pool } = pg

export type WorkflowsServiceTarget = {
  name: string
  url: string | undefined
}

export const postgresTarget: WorkflowsServiceTarget = {
  name: 'Postgres',
  url: process.env.POSTGRES_URL,
}

export function requireServiceEnv(target: WorkflowsServiceTarget) {
  if (!target.url && process.env.NMTJS_REQUIRE_SERVICE_TESTS === '1') {
    throw new Error(`${target.name} integration tests require POSTGRES_URL`)
  }
}

export function createTestContext() {
  return Context.empty()
}

export function createTestName(prefix: string) {
  return `${prefix}-${randomUUID()}`
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export type PostgresWorkflowHarness = {
  readonly pool: PgPool
  readonly runtime: ReturnType<typeof createPostgresWorkflowRuntime>
  cleanup(): Promise<void>
}

export async function createPostgresWorkflowHarness(
  target: WorkflowsServiceTarget = postgresTarget,
): Promise<PostgresWorkflowHarness> {
  if (!target.url) {
    throw new Error(`${target.name} integration tests require POSTGRES_URL`)
  }

  const pool = new Pool({ connectionString: target.url, max: 16 })
  const connection = createPostgresWorkflowConnection(pool)
  await installPostgresWorkflowSchemaForTesting(connection)
  await truncateWorkflowTables(pool)

  return {
    pool,
    runtime: createPostgresWorkflowRuntime({ connection }),
    async cleanup() {
      try {
        await truncateWorkflowTables(pool)
      } finally {
        await pool.end()
      }
    },
  }
}

async function truncateWorkflowTables(pool: PgPool) {
  await pool.query(`
    TRUNCATE TABLE
      workflow_schedules,
      workflow_commands,
      workflow_run_leases,
      workflow_node_children,
      workflow_attempts,
      workflow_nodes,
      workflow_runs
    RESTART IDENTITY CASCADE
  `)
}

export async function matchingKeys(client: Redis | Valkey, pattern: string) {
  let cursor = '0'
  const keys: string[] = []
  do {
    const result = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 1_000)
    cursor = result[0]
    for (const key of result[1]) keys.push(key)
  } while (cursor !== '0')
  return keys
}

export type RedisServiceTarget = {
  readonly name: string
  readonly url: string | undefined
  createClient(): Redis | Valkey
}

export const redisTargets: readonly RedisServiceTarget[] = [
  {
    name: 'Redis',
    url: process.env.REDIS_URL,
    createClient: () => new Redis(process.env.REDIS_URL!),
  },
  {
    name: 'Valkey',
    url: process.env.VALKEY_URL,
    createClient: () => new Valkey(process.env.VALKEY_URL!),
  },
]

/** Disposes each runtime, deletes its keys through its own client and quits. */
export async function disposeRedisRuntimes(
  runtimes: ReturnType<typeof createRedisWorkflowRuntime>[],
  clients: (Redis | Valkey)[],
) {
  await Promise.allSettled(
    runtimes.splice(0).map(async (runtime, index) => {
      await runtime.dispose?.()
      const client = clients[index]!
      const keys = await matchingKeys(client, `${runtime.keyPrefix}*`)
      for (let offset = 0; offset < keys.length; offset += 100) {
        await client.del(...keys.slice(offset, offset + 100))
      }
    }),
  )
  await Promise.allSettled(
    clients.splice(0).map(async (client) => await client.quit()),
  )
}

export function activityCommand(
  runId: string,
  workflowName: string,
  activityName: string,
) {
  return {
    kind: 'activityAttempt' as const,
    workflowName,
    activityName,
    runId,
    nodeName: activityName,
    childKey: '$self',
    attemptId: randomUUID(),
    leaseToken: randomUUID(),
    input: null,
  }
}
