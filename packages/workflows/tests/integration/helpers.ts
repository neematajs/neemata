import { randomUUID } from 'node:crypto'

import type { Pool as PgPool } from 'pg'
import { Container, createLogger } from '@nmtjs/core'
import pg from 'pg'

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

export function createTestContainer() {
  const logger = createLogger({ pinoOptions: { enabled: false } }, 'test')
  return new Container({ logger })
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
