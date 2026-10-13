import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { threadId } from 'node:worker_threads'

import * as workflows from '@nmtjs/workflows'
import { defineWorkflowsWorker } from '@nmtjs/workflows/neem'
import {
  createPostgresWorkflowConnection,
  createPostgresWorkflowRuntime,
} from '@nmtjs/workflows/postgres'
import pg from 'pg'

import { generation } from './generations.ts'

const eventsFile = process.env.WORKFLOW_EVENTS_FILE!
const hangFile = process.env.WORKFLOW_HANG_FILE!
const prefix = process.env.WORKFLOW_PREFIX!
const deployed = process.env.WORKFLOW_DEPLOYED!.split(',')
const pools: Record<string, string> = { v1: 'io', v2: 'heavy' }

// Set once per worker thread, so handlers can report the pool that ran them.
let servedBy = 'coordinator'

const hooks = {
  record(event: { step: string; revision: string }) {
    const line = JSON.stringify({ ...event, servedBy, threadId })
    appendFileSync(eventsFile, `${line}\n`)
  },
  // The first delivery of a `hang` input never returns: the process is killed
  // under it. A later delivery finds the marker and proceeds.
  async gate(input: string) {
    if (!input.startsWith('hang') || existsSync(hangFile)) return
    writeFileSync(hangFile, 'hung')
    await new Promise(() => {})
  },
}

const served = deployed.map((revision) =>
  generation(workflows, prefix, revision, pools[revision]!, hooks),
)

export default defineWorkflowsWorker({
  workflows: () => served.flatMap(({ workflows }) => workflows),
  tasks: () => served.flatMap(({ tasks }) => tasks),
  setup(ctx) {
    servedBy = ctx.data.pool ?? ctx.data.role
    const pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL })
    const connection = createPostgresWorkflowConnection(pool)
    return {
      runtime: createPostgresWorkflowRuntime({ connection }),
      dispose: () => pool.end(),
    }
  },
})
